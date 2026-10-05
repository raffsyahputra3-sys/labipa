// tests/worlds.test.js — v5.2 + v5.1 (checkpoint/diff/fork/arsip/role/deny).
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
// join/create sambil menangkap room:state yang dikirim server
async function enter(s, ev, data) {
  const st = new Promise((res) => s.once('room:state', res));
  const r = await ask(s, ev, data);
  return r.ok ? Object.assign({ state: await st }, r) : r;
}

describe('worlds', () => {
  before(async () => { await H.start(); });
  after(() => { socks.forEach((s) => s.disconnect()); H.stop(); });

  it('checkpoint → diff +N/-N/~N', async () => {
    const s = await sock();
    await new Promise((res) => s.emit('room:create', { code: 'DIFFW', name: 'G', items: [] }, res));
    const A = [
      { itemKey: 'table', pos: { x: 0, y: 0, z: 0 }, rotY: 0 },
      { itemKey: 'chair', pos: { x: 2, y: 0, z: 0 }, rotY: 0 }
    ];
    s.emit('world:update', { items: A });
    await sleep(2200);
    const c1 = await H.api('POST', '/api/worlds/DIFFW/checkpoints', { name: 'v1' });
    assert.equal(c1.status, 201);
    s.emit('world:update', { items: [{ itemKey: 'table', pos: { x: 0.2, y: 0, z: 0 }, rotY: 0 }] });
    await sleep(2200);
    s.disconnect();
    const c2 = await H.api('POST', '/api/worlds/DIFFW/checkpoints', { name: 'v2' });
    const d = await H.api('GET', '/api/worlds/DIFFW/checkpoints/' + c1.body.item.id + '/diff/' + c2.body.item.id);
    assert.equal(d.status, 200);
    assert.deepEqual(d.body.summary, { added: 0, removed: 1, moved: 1 });
  });

  it('fork terpisah dari induk', async () => {
    const f = await H.api('POST', '/api/worlds/DIFFW/fork', { name: 'Cabang' });
    assert.equal(f.status, 201);
    assert.ok(f.body.code);
    const st = await H.api('GET', '/api/worlds/' + f.body.code + '/state');
    assert.equal(st.body.meta.parentWorldId, 'DIFFW');
    assert.equal(st.body.meta.itemCount, 1);
  });

  it('participant:role host-only + viewer denied', async () => {
    const host = await sock();
    const hc = await new Promise((res) => host.emit('room:create', { name: 'H', items: [] }, res));
    const ed = await sock();
    let edId = null;
    await new Promise((res) => {
      host.on('peer:join', (m) => { edId = m.peer; res(); });
      ed.emit('room:join', { code: hc.code, name: 'E' }, () => {});
    });
    const denied = await new Promise((res) => {
      host.emit('participant:role', { to: edId, role: 'viewer' }, res);
    });
    assert.equal(denied.ok, true);
    const no = await new Promise((res) => {
      ed.on('world:denied', (m) => res(m));
      ed.emit('world:update', { items: [] });
      setTimeout(() => res(null), 1500);
    });
    assert.ok(no && no.reason === 'viewer');
    const self = await new Promise((res) => {
      ed.emit('participant:role', { to: edId, role: 'editor' }, res);
    });
    assert.equal(self.ok, false); // bukan host → tolak
    host.disconnect(); ed.disconnect();
  });

  it('arsip → deny → restore', async () => {
    const s = await sock();
    await new Promise((res) => s.emit('room:create', { code: 'ARSW', name: 'G', items: [{ itemKey: 'table', pos: { x: 1, y: 0, z: 1 }, rotY: 0 }] }, res));
    await sleep(2200);
    s.disconnect();
    const ar = await H.api('POST', '/api/worlds/ARSW/archive', {});
    assert.equal(ar.body.meta.status, 'archived');
    const rs = await H.api('POST', '/api/worlds/ARSW/restore', {});
    assert.equal(rs.status, 200);
    assert.equal(rs.body.itemCount, 1);
  });

  it('payload socket rusak tidak mematikan server', async () => {
    const s = await sock();
    await ask(s, 'room:create', { name: 'R', items: [] });
    s.emit('presence:update');
    s.emit('world:update', null);
    s.emit('room:lock', { locked: false }, 'bukan-fungsi');
    await sleep(500);
    const h = await H.api('GET', '/health');
    assert.equal(h.status, 200);
    s.disconnect();
  });

  it('item rusak disaring dari world:update', async () => {
    const s = await sock();
    const r = await ask(s, 'room:create', { name: 'S', items: [] });
    s.emit('world:update', { items: [null, { itemKey: 'table' }, { itemKey: 'table', pos: { x: 1, y: 0, z: 1 }, rotY: 0 }] });
    await sleep(300);
    const st = await H.api('GET', '/api/worlds/' + r.code + '/state');
    assert.equal(st.body.items.length, 1);
    s.disconnect();
  });

  it('host keluar → penerus berperan host & boleh edit', async () => {
    const host = await sock();
    const hc = await ask(host, 'room:create', { name: 'H', items: [] });
    const v = await sock();
    await ask(v, 'room:join', { code: hc.code, name: 'V' });
    await ask(host, 'participant:role', { to: v.id, role: 'viewer' });
    const promoted = new Promise((res) => v.once('room:host', res));
    host.disconnect();
    assert.equal((await promoted).peer, v.id);
    const denied = await new Promise((res) => {
      v.once('world:denied', res);
      v.emit('world:update', { items: [{ itemKey: 'table', pos: { x: 3, y: 0, z: 3 }, rotY: 0 }] });
      setTimeout(() => res(null), 600);
    });
    assert.equal(denied, null);
    const st = await H.api('GET', '/api/worlds/' + hc.code + '/state');
    assert.equal(st.body.meta.itemCount, 1);
    v.disconnect();
  });

  it('room kelas: siswa pertama bukan host, guru jadi host', async () => {
    const guru = await sock();
    const rc = await ask(guru, 'room:create', { code: 'KLS-P0-8A', name: 'Guru', role: 'guru' });
    assert.equal(rc.ok, true);
    assert.equal(rc.isClass, true);
    guru.disconnect();
    await sleep(300);
    // Siswa masuk duluan ke room kelas yang kosong → editor, bukan host
    const s1 = await sock();
    const j1 = await enter(s1, 'room:join', { code: 'KLS-P0-8A', name: 'S1', role: 'siswa' });
    assert.equal(j1.ok, true);
    assert.equal(j1.state.you.isHost, false);
    assert.equal(j1.state.you.role, 'editor');
    // ...sehingga tak bisa mengunci room / menurunkan guru
    assert.equal((await ask(s1, 'room:lock', { locked: true })).ok, false);
    // Client lama tanpa klaim role = bukan host juga (aman by default)
    const s2 = await sock();
    const j2 = await enter(s2, 'room:join', { code: 'KLS-P0-8A', name: 'S2' });
    assert.equal(j2.state.you.isHost, false);
    // Guru masuk belakangan → jadi host dan bisa mengunci
    const g2 = await sock();
    const j3 = await enter(g2, 'room:join', { code: 'KLS-P0-8A', name: 'Guru', role: 'guru' });
    assert.equal(j3.state.you.isHost, true);
    assert.equal(j3.state.you.role, 'host');
    assert.equal((await ask(g2, 'room:lock', { locked: true })).locked, true);
    s1.disconnect(); s2.disconnect(); g2.disconnect();
  });

  it('room kelas: host keluar tanpa guru tersisa → tanpa host', async () => {
    const guru = await sock();
    await ask(guru, 'room:create', { code: 'KLS-P0-8B', name: 'Guru', role: 'guru' });
    const s1 = await sock();
    await ask(s1, 'room:join', { code: 'KLS-P0-8B', name: 'S1', role: 'siswa' });
    const noHost = new Promise((res) => {
      let fired = false;
      s1.once('room:host', () => { fired = true; res(true); });
      setTimeout(() => res(fired), 800);
    });
    guru.disconnect();
    assert.equal(await noHost, false); // host TIDAK jatuh ke siswa
    s1.disconnect();
  });

  it('dunia kosong: kunci lepas + peserta pertama jadi host', async () => {
    const a = await sock();
    const rc = await ask(a, 'room:create', { name: 'A', items: [] });
    assert.equal((await ask(a, 'room:lock', { locked: true })).locked, true);
    a.disconnect();
    await sleep(300);
    const b = await sock();
    const j = await enter(b, 'room:join', { code: rc.code, name: 'B' });
    assert.equal(j.ok, true);
    assert.equal(j.state.you.isHost, true);
    assert.equal(j.state.you.role, 'host');
    assert.equal(j.state.locked, false);
    b.disconnect();
  });

  it('warna pemain tidak bentrok setelah keluar-masuk', async () => {
    const a = await sock();
    const rc = await ask(a, 'room:create', { name: 'A', items: [] });
    const b = await sock();
    const jb = await enter(b, 'room:join', { code: rc.code, name: 'B' });
    a.disconnect();
    await sleep(300);
    const c = await sock();
    const jc = await enter(c, 'room:join', { code: rc.code, name: 'C' });
    assert.notEqual(jc.state.you.color, jb.state.you.color);
    b.disconnect(); c.disconnect();
  });

  it('join dobel / pindah room tidak meninggalkan peer hantu', async () => {
    const a = await sock();
    const r1 = await ask(a, 'room:create', { name: 'A', items: [] });
    const b = await sock();
    await ask(b, 'room:join', { code: r1.code, name: 'B' });
    const again = await enter(b, 'room:join', { code: r1.code, name: 'B' });
    assert.equal(again.state.you.username, 'B');
    assert.equal(again.state.peers.length, 2);
    const r2 = await ask(b, 'room:create', { name: 'B', items: [] });
    assert.equal(r2.ok, true);
    await sleep(200);
    const st = await H.api('GET', '/api/worlds/' + r1.code + '/state');
    assert.equal(st.body.meta.online, 1);
    a.disconnect(); b.disconnect();
  });

  it('sesi berakhir → checkpoint session-idle', async () => {
    const s = await sock();
    const r = await ask(s, 'room:create', { name: 'I', items: [{ itemKey: 'table', pos: { x: 1, y: 0, z: 1 }, rotY: 0 }] });
    s.disconnect();
    await sleep(300);
    const cps = await H.api('GET', '/api/worlds/' + r.code + '/checkpoints');
    assert.equal(cps.body.count, 1);
    assert.equal(cps.body.items[0].trigger, 'session-idle');
  });
});
