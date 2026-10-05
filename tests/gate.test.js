// tests/gate.test.js — FR-18/19/20 (urutan penting: blokir paling akhir).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helper');

let token = null;

describe('gate', () => {
  before(async () => { await H.start(); });
  after(() => { H.stop(); });

  it('status: required & terkunci', async () => {
    const r = await H.api('GET', '/api/gate/status');
    assert.equal(r.status, 200);
    assert.equal(r.body.required, true);
    assert.equal(r.body.unlocked, false);
  });

  it('kunci salah → 401 + attemptsLeft', async () => {
    const r = await H.api('POST', '/api/gate/unlock', { key: 'SALAHXX' });
    assert.equal(r.status, 401);
    assert.equal(r.body.attemptsLeft, 4);
  });

  it('kunci benar → token 12 jam', async () => {
    const r = await H.api('POST', '/api/gate/unlock', { key: 'TESTKEY123' });
    assert.equal(r.status, 200);
    assert.ok(r.body.token);
    assert.equal(r.body.expiresIn, 43200);
    token = r.body.token;
  });

  it('status + audit tercatat', async () => {
    const s = await H.api('GET', '/api/gate/status', null, token);
    assert.equal(s.body.unlocked, true);
    const a = await H.api('GET', '/api/gate/audit?limit=10', null, token);
    assert.equal(a.status, 200);
    assert.ok(a.body.count >= 2);
    assert.ok(!('key' in (a.body.items[0] || {})));
  });

  it('rotasi via kunci lama', async () => {
    const r = await H.api('POST', '/api/gate/rotate', { oldKey: 'TESTKEY123', newKey: 'BARUKEY1' });
    assert.equal(r.status, 200);
    const ok = await H.api('POST', '/api/gate/unlock', { key: 'BARUKEY1' });
    assert.equal(ok.status, 200);
  });

  it('5x gagal → 403 blokir', async () => {
    for (let i = 0; i < 5; i++) await H.api('POST', '/api/gate/unlock', { key: 'NGACO' + i });
    const r = await H.api('POST', '/api/gate/unlock', { key: 'NGACO9' });
    assert.equal(r.status, 403);
  });
});
