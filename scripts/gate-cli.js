// LabIPA Gate CLI — rotasi / reset / verifikasi master key (PRD v4.0 FR-19, FR-23)
//   npm run rotate-key -- --new-key "XXXXXX"
//   npm run rotate-key            (generate acak 16 char)
//   npm run reset-key             (alias generate acak)
//   npm run verify-key -- --key "XXXXXX"
// Menulis hash scrypt ke MASTER_KEY_FILE (default ./data/masterkey.json,
// mode 0600). Server memantau file tsb (fs.watch) → berlaku ≤5 dtk.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const KEY_FILE = process.env.MASTER_KEY_FILE || path.join(DATA_DIR, 'masterkey.json');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
function scryptHash(key, salt) {
  return crypto.scryptSync(String(key), salt, 64).toString('hex');
}
function makeHash(key) {
  const salt = crypto.randomBytes(16).toString('hex');
  return 'scrypt$' + salt + '$' + scryptHash(key, salt);
}
function verify(key, stored) {
  try {
    const p = String(stored || '').split('$');
    if (p[0] !== 'scrypt' || !p[1] || !p[2]) return false;
    const a = Buffer.from(scryptHash(key, p[1]), 'hex');
    const b = Buffer.from(p[2], 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}
function randomKey(len) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < (len || 16); i++) s += c[crypto.randomInt(c.length)];
  return s;
}
function readFile() {
  try { return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')); } catch (e) { return null; }
}

const cmd = process.argv[2] || 'rotate';
if (cmd === 'verify') {
  const key = String(arg('--key') || '').toUpperCase().replace(/\s+/g, '');
  const f = readFile();
  const ok = f && f.hash && verify(key, f.hash);
  console.log(ok ? 'OK: kunci cocok.' : 'GAGAL: kunci tidak cocok / file hilang.');
  process.exit(ok ? 0 : 1);
} else if (cmd === 'rotate' || cmd === 'reset') {
  let nk = String(arg('--new-key') || '').toUpperCase().replace(/\s+/g, '');
  if (!nk) nk = randomKey(16);
  if (nk.length < 6 || nk.length > 32) {
    console.error('Kunci harus 6–32 karakter.');
    process.exit(1);
  }
  try { fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true }); } catch (e) {}
  fs.writeFileSync(KEY_FILE, JSON.stringify({ hash: makeHash(nk), createdAt: new Date().toISOString() }), { mode: 0o600 });
  console.log('Kunci berhasil dirotasi.');
  console.log('Kunci baru (simpan sekarang, tidak akan ditampilkan lagi):');
  console.log('   ', nk);
  console.log('Berlaku <= 5 detik (server watch file, tanpa restart).');
} else {
  console.error('Perintah: rotate | reset | verify --key XXX');
  process.exit(1);
}
