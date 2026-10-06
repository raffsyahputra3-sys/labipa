// tests/combat.test.js — mode tembak (HP / kill / respawn otomatis).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helper');
const io = require('socket.io-client');

const socks = []; // ditutup di after() — socket nyangkut = proses test tak pernah selesai
function sock() {
  return new Promise((resolve, reject) => {
    const s = io(H.BASE, { transports: ['websocket'] });
    socks.push(s);
    s.on('connect', () => resolve(s));
    setTimeout(() => reject(new Error('t/o')), 8000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
async function enter(s, ev, data) {
  const st = new Promise((res) => s.once('room:state', res));
  const r = await ask(s, ev, data);
  return r.ok ? Object.assign({ state: await st }, r) : r;
}

describe('combat', () => {
  before(async () => { await H.start(); });
  after(() => { socks.forEach((s) => s.disconnect()); H.stop(); });

  it('HP awal 100 + alive di room:state', async () => {
    const a = await sock();
    const ra = await enter(a, 'room:create', { name: 'A', items: [] });
    assert.equal(ra.state.you.hp, 100);
    assert.equal(ra.state.you.alive, true);
    const b = await sock();
    const peerJoined = new Promise((res) => a.once('peer:join', res));
    const rb = await enter(b, 'room:join', { code: ra.code, name: 'B' });
    assert.equal(rb.state.you.hp, 100);
    const pj = await peerJoined;
    assert.equal(pj.presence.hp, 100);
    assert.equal(pj.presence.alive, true);
    a.disconnect(); b.disconnect();
  });

  it('combat:hit mengurangi HP + disiarkan (damage 20)', async () => {
    const a = await sock();
    const ra = await enter(a, 'room:create', { name: 'A', items: [] });
    const b = await sock();
    await enter(b, 'room:join', { code: ra.code, name: 'B' });
    const got = new Promise((res) => b.once('combat:hit', res));
    const r = await ask(a, 'combat:hit', { to: b.id, damage: 20 });
    assert.equal(r.ok, true);
    assert.equal(r.hp, 80);
    const m = await got;
    assert.equal(m.to, b.id);
    assert.equal(m.hp, 80);
    assert.equal(m.alive, true);
    assert.equal(m.killed, false);
    a.disconnect(); b.disconnect();
  });

  it('damage di-clamp 1..50 (200 → 50)', async () => {
    const a = await sock();
    const ra = await enter(a, 'room:create', { name: 'A', items: [] });
    const b = await sock();
    await enter(b, 'room:join', { code: ra.code, name: 'B' });
    const r = await ask(a, 'combat:hit', { to: b.id, damage: 200 });
    assert.equal(r.ok, true);
    assert.equal(r.hp, 50); // 100 - 50 (clamp), bukan 100 - 200
    a.disconnect(); b.disconnect();
  });

  it('mati → combat:killed → respawn otomatis HP 100', async () => {
    const a = await sock();
    const ra = await enter(a, 'room:create', { name: 'A', items: [] });
    const b = await sock();
    await enter(b, 'room:join', { code: ra.code, name: 'B' });
    const killed = new Promise((res) => b.once('combat:killed', res));
    const respawn = new Promise((res) => b.once('combat:respawn', res));
    for (let i = 0; i < 5; i++) {
      const r = await ask(a, 'combat:hit', { to: b.id, damage: 20 });
      assert.equal(r.ok, true);
      if (i < 4) assert.equal(r.killed, false);
    }
    const k = await killed;
    assert.equal(k.victim, b.id);
    assert.equal(k.by, a.id);
    const rs = await respawn;
    assert.equal(rs.peer, b.id);
    assert.equal(rs.hp, 100);
    // korban hidup lagi → bisa kena hit lagi (HP berkurang dari 100)
    const r2 = await ask(a, 'combat:hit', { to: b.id, damage: 10 });
    assert.equal(r2.ok, true);
    assert.equal(r2.hp, 90);
    a.disconnect(); b.disconnect();
  });

  it('target tumbang tak bisa ditembak lagi', async () => {
    const a = await sock();
    const ra = await enter(a, 'room:create', { name: 'A', items: [] });
    const b = await sock();
    await enter(b, 'room:join', { code: ra.code, name: 'B' });
    await ask(a, 'combat:hit', { to: b.id, damage: 50 });
    await ask(a, 'combat:hit', { to: b.id, damage: 50 });
    const r = await ask(a, 'combat:hit', { to: b.id, damage: 10 });
    assert.equal(r.ok, false);
    a.disconnect(); b.disconnect();
  });

  it('combat:shoot disiarkan ke room + rate-limit spam', async () => {
    const a = await sock();
    const ra = await enter(a, 'room:create', { name: 'A', items: [] });
    const b = await sock();
    await enter(b, 'room:join', { code: ra.code, name: 'B' });
    const shot = new Promise((res) => b.once('combat:shoot', res));
    const o = { x: 1, y: 1.6, z: 2 }; const d = { x: 0, y: 0, z: -1 };
    const r1 = await ask(a, 'combat:shoot', { origin: o, dir: d });
    assert.equal(r1.ok, true);
    const m = await shot;
    assert.equal(m.from, a.id);
    assert.deepEqual([m.origin.x, m.origin.y, m.origin.z], [1, 1.6, 2]);
    // tembakan kedua seketika → ditolak (spam), bukan crash
    const r2 = await ask(a, 'combat:shoot', { origin: o, dir: d });
    assert.equal(r2.ok, false);
    a.disconnect(); b.disconnect();
  });

  it('payload combat rusak tidak mematikan server', async () => {
    const s = await sock();
    await ask(s, 'room:create', { name: 'R', items: [] });
    s.emit('combat:shoot');
    s.emit('combat:shoot', null);
    s.emit('combat:shoot', { origin: 'x', dir: [1, 2] });
    s.emit('combat:hit');
    s.emit('combat:hit', 'bukan-objek');
    s.emit('combat:hit', { to: 'tak-ada', damage: 10 }, 'bukan-fungsi');
    const r = await ask(s, 'combat:hit', { to: 'tak-ada', damage: 10 });
    assert.equal(r.ok, false);
    await sleep(500);
    const h = await H.api('GET', '/health');
    assert.equal(h.status, 200);
    s.disconnect();
  });
});
