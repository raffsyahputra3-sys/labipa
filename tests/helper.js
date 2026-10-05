// tests/helper.js — jalankan server sekali untuk semua test.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = parseInt(process.env.TEST_PORT || '3210', 10);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'labipa-test-'));
let child = null;

async function waitUp(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) return true;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server tidak start');
}

async function start() {
  // kunci gate deterministik untuk test
  require('node:child_process').execFileSync(process.execPath,
    [path.join(__dirname, '..', 'scripts', 'gate-cli.js'), 'rotate', '--', '--new-key', 'TESTKEY123'],
    { env: { ...process.env, DATA_DIR }, stdio: 'ignore' });
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR }, stdio: 'ignore'
  });
  await waitUp();
  return BASE;
}

function stop() {
  if (child) { try { child.kill('SIGKILL'); } catch (e) {} child = null; }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
}

async function api(method, p, body, token) {
  const r = await fetch(BASE + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

module.exports = { BASE, DATA_DIR, start, stop, api };
