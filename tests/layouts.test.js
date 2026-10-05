// tests/layouts.test.js — FR-06 (CRUD + lock + force + clone + publish + delete).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helper');
const io = require('socket.io-client');

let token = null;
let id = null;
let sock = null;

describe('layouts', () => {
  before(async () => {
    await H.start();
    const g = await H.api('POST', '/api/auth/guest', { name: 'Penguji' });
    token = g.body.access_token;
  });
  after(() => { if (sock) sock.disconnect(); H.stop(); });

  it('buat layout v1', async () => {
    const r = await H.api('POST', '/api/layouts',
      { name: 'Uji', items: [{ itemKey: 'table', pos: { x: 1, y: 0, z: 1 }, rotY: 0 }] }, token);
    assert.equal(r.status, 201);
    assert.equal(r.body.item.version, 1);
    id = r.body.item.id;
  });

  it('update versi benar → v2', async () => {
    const r = await H.api('PUT', '/api/layouts/' + id, { version: 1, items: [] }, token);
    assert.equal(r.status, 200);
    assert.equal(r.body.item.version, 2);
  });

  it('update versi basi → 409', async () => {
    const r = await H.api('PUT', '/api/layouts/' + id, { version: 1, items: [] }, token);
    assert.equal(r.status, 409);
    assert.ok(r.body.current);
  });

  it('force melewati lock', async () => {
    const r = await H.api('PUT', '/api/layouts/' + id, { version: 1, items: [], force: true }, token);
    assert.equal(r.status, 200);
    assert.equal(r.body.item.version, 3);
  });

  it('clone + publish + soft delete + restore', async () => {
    const c = await H.api('POST', '/api/layouts/' + id + '/clone', {}, token);
    assert.equal(c.status, 201);
    const p = await H.api('POST', '/api/layouts/' + id + '/publish', { classId: '8A-IPA-2026' }, token);
    assert.equal(p.status, 200);
    assert.equal(p.body.item.published, true);
    const d = await H.api('DELETE', '/api/layouts/' + id, null, token);
    assert.equal(d.status, 200);
    const gone = await H.api('GET', '/api/layouts/' + id, null, token);
    assert.equal(gone.status, 404);
    const back = await H.api('POST', '/api/layouts/' + id + '/restore', {}, token);
    assert.equal(back.status, 200);
  });

  it('live edit: draf siswa tidak menimpa dunia kelas, guru tetap bisa', async () => {
    const CLS = '8B-IPA-2026';
    const meja = { itemKey: 'table', pos: { x: 1, y: 0, z: 1 }, rotY: 0 };
    sock = io(H.BASE, { transports: ['websocket'] });
    await new Promise((res) => sock.on('connect', res));
    await new Promise((res) => sock.emit('room:create', { code: CLS, name: 'Guru', items: [meja] }, res));
    const itemCount = async () => (await H.api('GET', '/api/worlds/' + CLS + '/state')).body.meta.itemCount;

    const siswa = (await H.api('POST', '/api/auth/guest', { name: 'Siswa', classId: CLS })).body.access_token;
    const draf = await H.api('POST', '/api/layouts', { name: 'Draf', items: [] }, siswa);
    assert.equal(draf.body.item.classId, CLS);
    await H.api('PUT', '/api/layouts/' + draf.body.item.id, { version: 1, items: [] }, siswa);
    assert.equal(await itemCount(), 1);

    const guru = (await H.api('POST', '/api/auth/exchange', { code: 'GURU-1', classId: CLS })).body.access_token;
    const lay = await H.api('POST', '/api/layouts', { name: 'Kelas', items: [meja] }, guru);
    await H.api('PUT', '/api/layouts/' + lay.body.item.id, { version: 1, items: [meja, meja] }, guru);
    assert.equal(await itemCount(), 2);
  });
});
