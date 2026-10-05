// tests/worlds.test.js — v5.2 + v5.1 (checkpoint/diff/fork/arsip/role/deny).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helper');
const io = require('socket.io-client');

function sock() {
  return new Promise((resolve, reject) => {
    const s = io(H.BASE, { transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    setTimeout(() => reject(new Error('t/o')), 8000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('worlds', () => {
  before(async () => { await H.start(); });
  after(() => { H.stop(); });

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
});
