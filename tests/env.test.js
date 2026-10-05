// tests/env.test.js — server dengan env khusus (MASTER_KEY, ARCHIVE_DIR) +
// dunia read-only hasil restore disk + mock OIDC.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./helper');
const io = require('socket.io-client');

const ARCH = fs.mkdtempSync(path.join(os.tmpdir(), 'labipa-arch-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const socks = []; // ditutup di after() — socket nyangkut = proses test tak pernah selesai
function sock() {
  return new Promise((resolve, reject) => {
    const s = io(H.BASE, { transports: ['websocket'] });
    socks.push(s);
    s.on('connect', () => resolve(s));
    setTimeout(() => reject(new Error('t/o')), 8000);
  });
}
const ask = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));

describe('env & keamanan', () => {
  before(async () => {
    const lama = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    fs.writeFileSync(path.join(H.DATA_DIR, 'rooms.json'), JSON.stringify({
      v: 1, rooms: {
        ROWORLD: {
          code: 'ROWORLD', isClass: true, locked: false, maxPlayers: 32, hostUid: null, items: [],
          itemsUpdatedAt: Date.now(), createdAt: lama, status: 'read-only', lastActivityAt: lama, lastActivityBy: 'X'
        }
      }
    }));
    await H.start({ MASTER_KEY: 'rahasia123', ARCHIVE_DIR: ARCH }, { seedKey: false });
  });
  after(() => {
    socks.forEach((s) => s.disconnect());
    H.stop();
    try { fs.rmSync(ARCH, { recursive: true, force: true }); } catch (e) {}
  });

  it('MASTER_KEY huruf kecil tetap bisa dibuka', async () => {
    const r = await H.api('POST', '/api/gate/unlock', { key: 'rahasia123' });
    assert.equal(r.status, 200);
  });

  it('arsip ke ARCHIVE_DIR → restore utuh', async () => {
    const s = await sock();
    await ask(s, 'room:create', { code: 'ARSENV', name: 'G', items: [{ itemKey: 'table', pos: { x: 1, y: 0, z: 1 }, rotY: 0 }] });
    s.disconnect();
    await sleep(300);
    const ar = await H.api('POST', '/api/worlds/ARSENV/archive', {});
    assert.equal(ar.body.meta.status, 'archived');
    assert.ok(fs.existsSync(path.join(ARCH, 'ARSENV.json')));
    const rs = await H.api('POST', '/api/worlds/ARSENV/restore', {});
    assert.equal(rs.body.itemCount, 1);
  });

  it('dunia read-only tetap read-only di disk saat ada peserta', async () => {
    const s = await sock();
    await ask(s, 'room:join', { code: 'ROWORLD', name: 'P' });
    await sleep(2600);
    const disk = JSON.parse(fs.readFileSync(path.join(H.DATA_DIR, 'rooms.json'), 'utf8'));
    assert.equal(disk.rooms.ROWORLD.status, 'read-only');
    s.disconnect();
  });

  it('mock OIDC: parameter di-escape + redirect hanya ke origin sendiri', async () => {
    const html = await (await fetch(H.BASE + '/oidc/login?state=' + encodeURIComponent('"><script>alert(1)</script>'))).text();
    assert.ok(!html.includes('<script>alert(1)</script>'));
    const post = (redirectUri) => fetch(H.BASE + '/oidc/login', {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Guru', role: 'guru', classId: '8A-IPA-2026', redirect_uri: redirectUri })
    }).then((r) => r.headers.get('location'));
    assert.match(await post('https://evil.example/x'), /^\/\?code=OIDC-/);
    assert.match(await post(H.BASE + '/game.html'), /^\/game\.html\?code=OIDC-/);
  });
});
