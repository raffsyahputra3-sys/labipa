// =============================================================
// LabIPA 3D Studio · Socket.IO Multiplayer + Voice Chat Server
// PRD v1.0: presence 12 warna, suffix duplikat, event player:*
//           kompatibel, relay signaling WebRTC (offer/answer/ice),
//           room lock (host).
// PRD v2.0: Auth stub (SSO/OIDC-ready, guest mode), Layout API
//           (CRUD + version lock + clone/publish/soft-delete),
//           Room = Kelas (kode deterministik), Live Edit flag,
//           dokumentasi di GET /api/docs.
// =============================================================
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
app.use(express.json({ limit: '2mb' }));
// IP asli di balik proxy (Render) untuk rate limit & audit
app.set('trust proxy', true);
const server = http.createServer(app);

// ---------- Feature flags (PRD v2 §7.4) ----------
const FLAGS = {
  ALLOW_GUEST: process.env.ALLOW_GUEST !== 'false', // default true utk demo
  ENABLE_LIVE_EDIT: process.env.ENABLE_LIVE_EDIT !== 'false',
  SSO_ISSUER: process.env.SSO_ISSUER || '',
  SSO_CLIENT_ID: process.env.SSO_CLIENT_ID || 'labipa-3d-studio'
};

// =============================================================
// PERSISTENCE (PRD v5.2 — dunia tetap utuh antar sesi & restart)
// File JSON di DATA_DIR; peer/transient tidak ikut disimpan.
// =============================================================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
function dataRead(file, fb) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch (e) { return fb; }
}
function dataWrite(file, obj, mode) {
  try {
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(obj), { mode: mode || 0o644 });
    return true;
  } catch (e) { return false; }
}
let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistAll(); }, 2000);
}
function persistAll() {
  try {
    const roomsObj = {};
    for (const [code, r] of rooms) {
      roomsObj[code] = {
        code: r.code, isClass: !!r.isClass, locked: !!r.locked,
        maxPlayers: r.maxPlayers, hostUid: r.hostUid,
        items: r.items, itemsUpdatedAt: r.itemsUpdatedAt, itemsUpdatedBy: r.itemsUpdatedBy,
        createdAt: r.createdAt, status: r.peers && r.peers.size ? 'active' : (r.status || 'idle'),
        lastActivityAt: r.lastActivityAt, lastActivityBy: r.lastActivityBy,
        itemCount: Array.isArray(r.items) ? r.items.length : 0
      };
    }
    dataWrite('rooms.json', { v: 1, rooms: roomsObj });
    dataWrite('layouts.json', { v: 1, items: [...layouts.values()] });
  } catch (e) {}
}

// CORS: izinkan semua origin (aman untuk kelas, ganti kalau perlu)
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e6,   // 1 MB — cukup untuk chunk voice
  pingTimeout: 10000,
  pingInterval: 5000,
  // Konektivitas: pulihkan sesi saat reconnect singkat (putus <2 mnt)
  // tanpa handshake ulang penuh — melengkapi auto-rejoin di client.
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// Health check untuk cron-job.org
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// =============================================================
// PRD v4.0 — SINGLE-KEY ACCESS CONTROL (Master Key Gate)
// Satu kunci master (hash scrypt + compare timing-safe, tanpa
// plaintext di bundle), rate limit 5/15 mnt/IP, audit append-only,
// rotasi tanpa restart (file watch / endpoint / CLI), JWT 12 jam.
// Deviasi dari PRD: bcrypt/jsonwebtoken diganti crypto bawaan
// Node (tanpa dep native) dengan properti setara.
// =============================================================
const GATE_REQUIRED = process.env.GATE_REQUIRED !== 'false'; // default: gate aktif
const GATE_FILE = process.env.MASTER_KEY_FILE || path.join(DATA_DIR, 'masterkey.json');
const GATE_AUDIT_FILE = path.join(DATA_DIR, 'gate-audit.jsonl');
const GATE_GRACE_MS = 60 * 1000;
const GATE_MAX_ATTEMPTS = parseInt(process.env.GATE_MAX_ATTEMPTS || '5', 10);
const GATE_BLOCK_MS = 15 * 60 * 1000;
const GATE_TOKEN_EXP = 12 * 3600; // 12 jam
const GATE_WHITELIST = String(process.env.GATE_IP_WHITELIST || '127.0.0.1,::1').split(',').map(s => s.trim());

let gateHash = null, prevGateHash = null, rotatedAt = 0;
const gateFails = new Map();   // ip -> { fails:[ts], blockedUntil:ts }
const revokedGateTokens = new Set();

function gateScrypt(key, salt) {
  return crypto.scryptSync(String(key), salt, 64).toString('hex');
}
function gateMakeHash(key) {
  const salt = crypto.randomBytes(16).toString('hex');
  return 'scrypt$' + salt + '$' + gateScrypt(key, salt);
}
function gateVerify(key, stored) {
  try {
    const p = String(stored || '').split('$');
    if (p[0] !== 'scrypt' || !p[1] || !p[2]) return false;
    const a = Buffer.from(gateScrypt(key, p[1]), 'hex');
    const b = Buffer.from(p[2], 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}
function gateRandomKey(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < (len || 16); i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}
function gateLoadFile() {
  try {
    const raw = fs.readFileSync(GATE_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j && j.hash && j.hash !== gateHash) {
      prevGateHash = gateHash; gateHash = j.hash; rotatedAt = Date.now();
      return true;
    }
  } catch (e) {}
  return false;
}
function gateSaveFile(hash) {
  try {
    fs.writeFileSync(GATE_FILE, JSON.stringify({ hash: hash, createdAt: new Date().toISOString() }), { mode: 0o600 });
    return true;
  } catch (e) { return false; }
}
(function gateInit() {
  if (!gateLoadFile()) {
    if (process.env.MASTER_KEY) {
      gateHash = gateMakeHash(process.env.MASTER_KEY.trim());
      gateSaveFile(gateHash);
      console.log('[GATE] kunci dari env MASTER_KEY tersimpan (hash).');
    } else {
      const k = gateRandomKey(16);
      gateHash = gateMakeHash(k);
      gateSaveFile(gateHash);
      console.log('');
      console.log('  ╔══════════════════════════════════════════════════╗');
      console.log('  ║  GATE: kunci master dibuat otomatis (sekali)     ║');
      console.log('  ║  >>> ' + k + ' <<<                          ║');
      console.log('  ║  Simpan & rotasi via: npm run rotate-key         ║');
      console.log('  ╚══════════════════════════════════════════════════╝');
      console.log('');
    }
  }
  // Rotasi tanpa restart: CLI/endpoint tulis file → watch refresh ≤5 dtk
  try {
    let wt = null;
    fs.watch(path.dirname(GATE_FILE), { persistent: false }, (ev, name) => {
      if (name && GATE_FILE.endsWith(name)) {
        if (wt) clearTimeout(wt);
        wt = setTimeout(() => { if (gateLoadFile()) console.log('[GATE] kunci dirotasi via file (tanpa restart).'); }, 500);
      }
    });
  } catch (e) {}
})();
// Secret JWT gate (persist agar token survive restart)
let gateSecret = process.env.GATE_JWT_SECRET || '';
if (!gateSecret) {
  try { gateSecret = fs.readFileSync(path.join(DATA_DIR, 'gate-secret'), 'utf8').trim(); } catch (e) {}
  if (!gateSecret) {
    gateSecret = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(path.join(DATA_DIR, 'gate-secret'), gateSecret, { mode: 0o600 }); } catch (e) {}
  }
}
function b64u(o) { return Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url'); }
function gateSign(ip) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u({ gate: true, ip: ip, iat: now, exp: now + GATE_TOKEN_EXP });
  return body + '.' + crypto.createHmac('sha256', gateSecret).update(body).digest('base64url');
}
function gateCheck(token) {
  try {
    if (!token || revokedGateTokens.has(token)) return null;
    const p = String(token).split('.');
    if (p.length !== 3) return null;
    const sig = crypto.createHmac('sha256', gateSecret).update(p[0] + '.' + p[1]).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(p[2]);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(p[1], 'base64url').toString('utf8'));
    if (!payload.gate || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch (e) { return null; }
}
function gateIp(req) {
  const f = req.headers['x-forwarded-for'];
  if (f) return String(f).split(',')[0].trim();
  return (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown').toString().slice(0, 64);
}
function gateAudit(ev) {
  try {
    ev.id = 'log-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    ev.timestamp = new Date().toISOString();
    fs.appendFileSync(GATE_AUDIT_FILE, JSON.stringify(ev) + '\n');
  } catch (e) {}
}
function gateRecentFails(ip, windowMs) {
  const rec = gateFails.get(ip);
  if (!rec) return 0;
  const cut = Date.now() - windowMs;
  rec.fails = rec.fails.filter(t => t > cut);
  return rec.fails.length;
}
function gateRecordFail(ip) {
  let rec = gateFails.get(ip);
  if (!rec) { rec = { fails: [], blockedUntil: 0 }; gateFails.set(ip, rec); }
  rec.fails.push(Date.now());
  const f15 = gateRecentFails(ip, 15 * 60 * 1000);
  const f60 = gateRecentFails(ip, 3600 * 1000);
  if (f60 >= 20) { rec.blockedUntil = Date.now() + 24 * 3600 * 1000; return { blocked: true, ms: 24 * 3600 * 1000 }; }
  if (f15 >= GATE_MAX_ATTEMPTS) { rec.blockedUntil = Date.now() + GATE_BLOCK_MS; return { blocked: true, ms: GATE_BLOCK_MS }; }
  return { blocked: false, fails: f15 };
}

app.get('/api/gate/status', (req, res) => {
  const t = readBearer(req);
  res.json({ ok: true, required: GATE_REQUIRED, unlocked: !!gateCheck(t) });
});
app.post('/api/gate/unlock', (req, res) => {
  const ip = gateIp(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 200);
  const rawKey = String((req.body && req.body.key) || '').toUpperCase().replace(/\s+/g, '');
  const rec = gateFails.get(ip);
  if (rec && rec.blockedUntil > Date.now()) {
    gateAudit({ event: 'gate_unlock_attempt', success: false, ip: ip, userAgent: ua, keyLength: rawKey.length, keyPrefix: rawKey.slice(0, 2), reason: 'blocked', attemptNumber: gateRecentFails(ip, 15 * 60 * 1000) });
    return res.status(403).json({ ok: false, error: 'IP diblokir sementara.', until: new Date(rec.blockedUntil).toISOString() });
  }
  if (rawKey.length < 6 || rawKey.length > 32) {
    gateAudit({ event: 'gate_unlock_attempt', success: false, ip: ip, userAgent: ua, keyLength: rawKey.length, keyPrefix: rawKey.slice(0, 2), reason: 'invalid_format', attemptNumber: gateRecentFails(ip, 15 * 60 * 1000) });
    return res.status(401).json({ ok: false, error: 'Format kunci salah (6–32 karakter).' });
  }
  const valid = gateVerify(rawKey, gateHash);
  const inGrace = prevGateHash && (Date.now() - rotatedAt) < GATE_GRACE_MS && gateVerify(rawKey, prevGateHash);
  if (!valid && !inGrace) {
    const r = gateRecordFail(ip);
    gateAudit({ event: 'gate_unlock_attempt', success: false, ip: ip, userAgent: ua, keyLength: rawKey.length, keyPrefix: rawKey.slice(0, 2), reason: 'invalid_key', attemptNumber: gateRecentFails(ip, 15 * 60 * 1000) });
    if (r.blocked) return res.status(403).json({ ok: false, error: 'Terlalu banyak percobaan. IP diblokir.', attemptNumber: r.fails });
    return res.status(401).json({ ok: false, error: 'Kunci salah.', attemptsLeft: Math.max(0, GATE_MAX_ATTEMPTS - (r.fails || 0)) });
  }
  gateFails.delete(ip);
  gateAudit({ event: 'gate_unlock_attempt', success: true, ip: ip, userAgent: ua, keyLength: rawKey.length, keyPrefix: rawKey.slice(0, 2), reason: 'ok', attemptNumber: 0 });
  res.json({ ok: true, token: gateSign(ip), expiresIn: GATE_TOKEN_EXP });
});
// Rotasi: kunci lama + IP whitelist (default localhost)
app.post('/api/gate/rotate', (req, res) => {
  const ip = gateIp(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 200);
  const host = (req.socket && (req.socket.remoteAddress || '')) + '';
  const allowed = GATE_WHITELIST.some(w => ip === w || host.includes(w) || ip === '::ffff:' + w);
  if (!allowed) {
    gateAudit({ event: 'gate_rotate', success: false, ip: ip, userAgent: ua, reason: 'not_whitelisted' });
    return res.status(403).json({ ok: false, error: 'Rotasi hanya dari IP whitelist.' });
  }
  const oldKey = String((req.body && req.body.oldKey) || '').toUpperCase().replace(/\s+/g, '');
  const newKey = String((req.body && req.body.newKey) || '').toUpperCase().replace(/\s+/g, '');
  if (!gateVerify(oldKey, gateHash)) {
    gateAudit({ event: 'gate_rotate', success: false, ip: ip, userAgent: ua, reason: 'bad_old_key' });
    return res.status(401).json({ ok: false, error: 'Kunci lama salah.' });
  }
  if (newKey.length < 6 || newKey.length > 32) {
    return res.status(400).json({ ok: false, error: 'Kunci baru harus 6–32 karakter.' });
  }
  prevGateHash = gateHash; rotatedAt = Date.now();
  gateHash = gateMakeHash(newKey);
  gateSaveFile(gateHash);
  gateAudit({ event: 'gate_rotate', success: true, ip: ip, userAgent: ua, keyLength: newKey.length, keyPrefix: newKey.slice(0, 2), reason: 'ok' });
  res.json({ ok: true, graceSeconds: Math.round(GATE_GRACE_MS / 1000) });
});
app.get('/api/gate/audit', (req, res) => {
  if (!gateCheck(readBearer(req))) return res.status(401).json({ ok: false, error: 'Gate token tidak valid.' });
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
  let lines = [];
  try { lines = fs.readFileSync(GATE_AUDIT_FILE, 'utf8').split('\n').filter(Boolean); } catch (e) {}
  const items = lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  res.json({ ok: true, count: items.length, items: items });
});
app.post('/api/gate/lock', (req, res) => {
  const t = readBearer(req);
  if (!gateCheck(t)) return res.status(401).json({ ok: false, error: 'Gate token tidak valid.' });
  revokedGateTokens.add(t);
  gateAudit({ event: 'gate_lock', success: true, ip: gateIp(req), reason: 'manual' });
  res.json({ ok: true });
});

// =============================================================
// ROOM STATE (in-memory)
// =============================================================
const rooms = new Map();
// PRD v1.0 Lampiran 10.1 — palet 12 warna pemain
const MP_COLORS = [
  '#3D7EA6', '#D97706', '#2E5C3E', '#8B1E1E',
  '#5D4A34', '#4B3A2A', '#2A4A78', '#B8892B',
  '#7A3E68', '#3F6B34', '#8A939B', '#424242'
];

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  // Hindari awalan "LAB" agar konsisten dengan normalisasi kode di landing
  // (prefix LAB-XXXX-XX selalu aman dibuang)
  do {
    s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  } while (s.startsWith('LAB'));
  return s;
}

// PRD v2 FR-07: kode room boleh berupa classId SIAKAD
// (huruf/angka/strip, 3–24 char, mis. "8A-IPA-2026") atau kode acak 6 char.
function normalizeRoomCode(input) {
  const c = String(input || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
  if (/^[A-Z0-9]{6}$/.test(c)) return { code: c, isClass: false };
  if (/^[A-Z0-9][A-Z0-9-]{1,22}[A-Z0-9]$/.test(c)) return { code: c, isClass: true };
  return { code: '', isClass: false };
}

// PRD v1.0 FR-01: sanitasi nama (maks 16 char, tanpa HTML/script)
function sanitizeName(name) {
  let n = String(name == null ? '' : name).replace(/[<>&"'`\0]/g, '').trim().slice(0, 16);
  if (!n) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let r = '';
    for (let i = 0; i < 4; i++) r += chars[Math.floor(Math.random() * chars.length)];
    n = 'Pemain-' + r;
  }
  return n;
}

// PRD v1.0 FR-01 edge case: nama duplikat → tambah suffix (2), (3)
function uniqueName(room, name) {
  const taken = new Set();
  for (const p of room.peers.values()) taken.add(p.username);
  if (!taken.has(name)) return name;
  for (let i = 2; i < 100; i++) {
    const suffix = ' (' + i + ')';
    const cand = name.slice(0, 16 - suffix.length) + suffix;
    if (!taken.has(cand)) return cand;
  }
  return name.slice(0, 10) + '-' + Date.now().toString(36).slice(-4);
}

function peersPublic(room) {
  const out = [];
  for (const [sid, p] of room.peers) {
    out.push({ peer: sid, isMe: false, presence: p, isHost: !!p.isHost });
  }
  return out;
}

// Avatar config dari client — sanitasi ketat sebelum disimpan/broadcast
function sanitizeAvatar(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {};
  const hex = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : null;
  const str = (v, max) => (typeof v === 'string' && v.length <= max && /^[A-Za-z0-9_# ]+$/.test(v)) ? v : null;
  const skin = hex(a.skinColor); if (skin) out.skinColor = skin;
  const hair = hex(a.hairColor); if (hair) out.hairColor = hair;
  const eye = hex(a.eyeColor); if (eye) out.eyeColor = eye;
  const coat = hex(a.coatColor); if (coat) out.coatColor = coat;
  // PRD v2: field tambahan agar avatar studio === avatar game (100% match).
  const vest = hex(a.vestColor); if (vest) out.vestColor = vest;
  const visor = hex(a.visorColor); if (visor) out.visorColor = visor;
  const hs = str(a.hairstyle, 32); if (hs) out.hairstyle = hs;
  const ew = str(a.eyewear, 32); if (ew) out.eyewear = ew;
  const st = str(a.suitType, 32); if (st) out.suitType = st;
  const sn = str(a.skinName, 32); if (sn) out.skinName = sn;
  const hp = str(a.handProp, 32); if (hp) out.handProp = hp;
  return Object.keys(out).length ? out : null;
}

function joinRoom(socket, room, name, isHost, avatar) {
  socket.join(room.code);
  socket.data.roomCode = room.code;

  const color = MP_COLORS[room.peers.size % MP_COLORS.length];

  const presence = {
    uid: socket.id,
    username: uniqueName(room, sanitizeName(name)),
    color: color,
    isHost: !!isHost,
    voice: false,
    avatar: sanitizeAvatar(avatar),
    x: 1, y: 1.6, z: 6, rotY: 0
  };
  room.peers.set(socket.id, presence);
  room.status = 'active';
  room.lastActivityAt = new Date().toISOString();
  room.lastActivityBy = presence.username;
  schedulePersist();

  socket.emit('room:state', {
    code: room.code,
    isClass: !!room.isClass,
    locked: !!room.locked,
    maxPlayers: room.maxPlayers,
    items: room.items,
    itemsUpdatedAt: room.itemsUpdatedAt,
    itemsUpdatedBy: room.itemsUpdatedBy,
    you: {
      uid: socket.id,
      color: color,
      isHost: !!isHost,
      username: presence.username
    },
    peers: peersPublic(room).map(p => ({
      peer: p.peer,
      isMe: p.peer === socket.id,
      isHost: p.isHost,
      presence: p.presence
    }))
  });

  socket.to(room.code).emit('peer:join', {
    peer: socket.id,
    isMe: false,
    isHost: !!isHost,
    presence: presence
  });
  // PRD v1.0 §6.2 — alias event player:join untuk kompatibilitas skema
  socket.to(room.code).emit('player:join', {
    id: socket.id, name: presence.username, color: presence.color,
    position: { x: presence.x, y: presence.y, z: presence.z }
  });
}

// =============================================================
// PRD v2 FR-05 — AUTH STUB (SSO/OIDC-ready)
// Alur produksi: client redirect ke SSO_ISSUER, tukar code di
// /api/auth/exchange dengan verifikasi RS256 di IdP. Stub ini
// menerbitkan token mock agar frontend & E2E bisa jalan tanpa
// SIAKAD; ganti verifyMock dengan jsonwebtoken saat integrasi.
// =============================================================
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function mockToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    userId: user.userId, name: user.name, role: user.role,
    classId: user.classId || null, email: user.email || null,
    iat: now, exp: now + 3600 // access ≤ 1 jam (PRD v2 FR-05)
  };
  return b64url({ alg: 'MOCK', typ: 'JWT' }) + '.' + b64url(payload) + '.mock-signature';
}
function readBearer(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}
function mockVerify(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!p.userId || !p.name) return null;
    if (p.exp && p.exp * 1000 < Date.now()) return null;
    return p;
  } catch (e) { return null; }
}

app.get('/api/flags', (req, res) => {
  res.json({ ok: true, allowGuest: FLAGS.ALLOW_GUEST, liveEdit: FLAGS.ENABLE_LIVE_EDIT });
});

// Guest mode demo publik (feature flag ALLOW_GUEST)
app.post('/api/auth/guest', (req, res) => {
  if (!FLAGS.ALLOW_GUEST) return res.status(403).json({ ok: false, error: 'Guest mode dimatikan.' });
  const name = sanitizeName((req.body && req.body.name) || 'Tamu');
  const user = {
    userId: 'GUEST-' + Date.now().toString(36).toUpperCase(),
    name: name, role: 'siswa',
    classId: (req.body && req.body.classId) || null
  };
  res.json({ ok: true, access_token: mockToken(user), token_type: 'Bearer', expires_in: 3600, user: user });
});

// Tukar code SSO → token (stub; hubungkan ke SSO_ISSUER saat integrasi)
app.post('/api/auth/exchange', (req, res) => {
  const code = req.body && req.body.code;
  if (!code) return res.status(400).json({ ok: false, error: 'code wajib diisi.' });
  if (FLAGS.SSO_ISSUER) {
    return res.status(501).json({ ok: false, error: 'SSO upstream belum dikonfigurasi di server ini.' });
  }
  // Mode dev tanpa SIAKAD: code "GURU-*" → guru, lainnya siswa (untuk QA role-based)
  const isGuru = /^GURU/i.test(String(code));
  const user = {
    userId: (isGuru ? 'SIAKAD-GURU-' : 'SIAKAD-') + String(code).slice(0, 8).toUpperCase(),
    name: (req.body && req.body.name) ? sanitizeName(req.body.name) : (isGuru ? 'Guru Demo' : 'Siswa Demo'),
    role: isGuru ? 'guru' : 'siswa',
    classId: (req.body && req.body.classId) || '8A-IPA-2026'
  };
  res.json({ ok: true, access_token: mockToken(user), token_type: 'Bearer', expires_in: 3600, user: user });
});

app.get('/api/auth/me', (req, res) => {
  const u = mockVerify(readBearer(req));
  if (!u) return res.status(401).json({ ok: false, error: 'Token tidak valid / kedaluwarsa.' });
  res.json({ ok: true, user: u });
});

// =============================================================
// PRD v2 FR-06 — LAYOUT API (CRUD + optimistic lock + clone +
// publish + soft delete). Store in-memory; cukup untuk sprint.
// =============================================================
const layouts = new Map();
// PRD v5.2: restore dunia + layout dari disk saat boot (survive restart)
(function restorePersisted() {
  try {
    const r = dataRead('rooms.json', null);
    if (r && r.rooms) {
      for (const code of Object.keys(r.rooms)) {
        const s = r.rooms[code];
        if (!s || !s.code) continue;
        rooms.set(code, {
          code: s.code, isClass: !!s.isClass, locked: !!s.locked,
          maxPlayers: s.maxPlayers || 6, hostUid: s.hostUid || null,
          items: Array.isArray(s.items) ? s.items : [],
          itemsUpdatedAt: s.itemsUpdatedAt || Date.now(),
          itemsUpdatedBy: s.itemsUpdatedBy || null,
          createdAt: s.createdAt || new Date().toISOString(),
          status: 'idle', // peer transient tidak dis restore; dunia idle sampai ada yang join
          lastActivityAt: s.lastActivityAt || null, lastActivityBy: s.lastActivityBy || null,
          peers: new Map()
        });
      }
      if (rooms.size) console.log('[WORLD] restore ' + rooms.size + ' dunia dari disk.');
    }
  } catch (e) {}
  try {
    const l = dataRead('layouts.json', null);
    if (l && Array.isArray(l.items)) {
      for (const it of l.items) { if (it && it.id) layouts.set(it.id, it); }
      if (layouts.size) console.log('[WORLD] restore ' + layouts.size + ' layout dari disk.');
    }
  } catch (e) {}
})();
// Sapu dunia idle >30 hari (non-kelas). Room kelas dipertahankan.
setInterval(() => {
  try {
    const cut = Date.now() - 30 * 24 * 3600 * 1000;
    for (const [code, r] of rooms) {
      if (r.isClass || (r.peers && r.peers.size)) continue;
      const last = r.lastActivityAt ? Date.parse(r.lastActivityAt) : (r.itemsUpdatedAt || 0);
      if (last && last < cut) { rooms.delete(code); console.log('[WORLD] arsip-hapus dunia idle:', code); }
    }
    schedulePersist();
  } catch (e) {}
}, 3600 * 1000);
function uid(prefix) {
  return (prefix || 'layout') + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function publicLayout(l) {
  return {
    id: l.id, name: l.name, ownerId: l.ownerId, ownerName: l.ownerName,
    classId: l.classId, version: l.version, published: !!l.published,
    createdAt: l.createdAt, updatedAt: l.updatedAt, items: l.items
  };
}
function validItems(items) {
  if (!Array.isArray(items)) return false;
  return items.every(it => it && typeof it.itemKey === 'string' &&
    it.pos && typeof it.pos.x === 'number' && typeof it.pos.z === 'number');
}
function authUser(req) {
  const t = readBearer(req);
  if (t) { const u = mockVerify(t); if (u) return u; }
  // Tanpa token: perlakukan sebagai guest anonim (boleh baca/tulis sandbox)
  return { userId: 'ANON', name: 'Anon', role: 'siswa', classId: null };
}

app.get('/api/layouts', (req, res) => {
  const u = authUser(req);
  const { classId, owner } = req.query;
  let list = [...layouts.values()].filter(l => !l.deletedAt);
  if (classId) list = list.filter(l => l.classId === classId);
  if (owner === 'me') list = list.filter(l => l.ownerId === u.userId);
  // Role-based (PRD v2 FR-05): siswa hanya lihat miliknya/published kelasnya
  if (u.role === 'siswa') {
    list = list.filter(l => l.ownerId === u.userId || (l.published && (!u.classId || l.classId === u.classId)));
  }
  list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json({ ok: true, items: list.map(publicLayout) });
});

app.get('/api/layouts/:id', (req, res) => {
  const l = layouts.get(req.params.id);
  if (!l || l.deletedAt) return res.status(404).json({ ok: false, error: 'Layout tidak ditemukan.' });
  res.json({ ok: true, item: publicLayout(l) });
});

app.post('/api/layouts', (req, res) => {
  const u = authUser(req);
  const b = req.body || {};
  if (!validItems(b.items)) return res.status(400).json({ ok: false, error: 'items tidak valid.' });
  const now = new Date().toISOString();
  const l = {
    id: uid('layout'),
    name: String(b.name || 'Layout tanpa nama').slice(0, 80),
    ownerId: u.userId, ownerName: u.name,
    classId: b.classId ? String(b.classId).slice(0, 24) : (u.classId || null),
    version: 1, published: false,
    createdAt: now, updatedAt: now, deletedAt: null,
    items: b.items
  };
  layouts.set(l.id, l);
  schedulePersist();
  res.status(201).json({ ok: true, item: publicLayout(l) });
});

// Optimistic lock: version mismatch → 409 Conflict (PRD v2 FR-06)
app.put('/api/layouts/:id', (req, res) => {
  const u = authUser(req);
  const l = layouts.get(req.params.id);
  if (!l || l.deletedAt) return res.status(404).json({ ok: false, error: 'Layout tidak ditemukan.' });
  if (l.ownerId !== u.userId && u.role !== 'guru' && u.userId !== 'ANON') {
    return res.status(403).json({ ok: false, error: 'Hanya pemilik/guru yang boleh mengubah.' });
  }
  const b = req.body || {};
  if (typeof b.version !== 'number' || b.version !== l.version) {
    return res.status(409).json({ ok: false, error: 'Version conflict — muat ulang layout terbaru.', current: publicLayout(l) });
  }
  if (b.items !== undefined && !validItems(b.items)) {
    return res.status(400).json({ ok: false, error: 'items tidak valid.' });
  }
  if (b.items !== undefined) l.items = b.items;
  if (typeof b.name === 'string' && b.name.trim()) l.name = b.name.trim().slice(0, 80);
  l.version += 1;
  l.updatedAt = new Date().toISOString();
  // Live Edit: siarkan versi baru ke room kelas (guru wins)
  if (FLAGS.ENABLE_LIVE_EDIT && l.classId) {
    const room = rooms.get(String(l.classId).toUpperCase());
    if (room) {
      room.items = l.items; room.itemsUpdatedAt = Date.now(); room.itemsUpdatedBy = 'api';
      io.to(room.code).emit('world:update', {
        items: room.items, itemsUpdatedAt: room.itemsUpdatedAt,
        itemsUpdatedBy: 'api', version: l.version
      });
    }
  }
  schedulePersist();
  res.json({ ok: true, item: publicLayout(l) });
});

// Soft delete (restore 30 hari — dihitung dari deletedAt)
app.delete('/api/layouts/:id', (req, res) => {
  const u = authUser(req);
  const l = layouts.get(req.params.id);
  if (!l || l.deletedAt) return res.status(404).json({ ok: false, error: 'Layout tidak ditemukan.' });
  if (l.ownerId !== u.userId && u.role !== 'guru' && u.userId !== 'ANON') {
    return res.status(403).json({ ok: false, error: 'Hanya pemilik/guru yang boleh menghapus.' });
  }
  l.deletedAt = new Date().toISOString();
  schedulePersist();
  res.json({ ok: true, restoreUntilDays: 30 });
});

app.post('/api/layouts/:id/restore', (req, res) => {
  const l = layouts.get(req.params.id);
  if (!l || !l.deletedAt) return res.status(404).json({ ok: false, error: 'Layout tidak ditemukan / tidak terhapus.' });
  l.deletedAt = null;
  l.updatedAt = new Date().toISOString();
  schedulePersist();
  res.json({ ok: true, item: publicLayout(l) });
});

app.post('/api/layouts/:id/clone', (req, res) => {
  const u = authUser(req);
  const l = layouts.get(req.params.id);
  if (!l || l.deletedAt) return res.status(404).json({ ok: false, error: 'Layout tidak ditemukan.' });
  const now = new Date().toISOString();
  const c = {
    id: uid('layout'), name: (l.name + ' (salinan)').slice(0, 80),
    ownerId: u.userId, ownerName: u.name, classId: l.classId,
    version: 1, published: false, createdAt: now, updatedAt: now,
    deletedAt: null, items: JSON.parse(JSON.stringify(l.items))
  };
  layouts.set(c.id, c);
  schedulePersist();
  res.status(201).json({ ok: true, item: publicLayout(c) });
});

app.post('/api/layouts/:id/publish', (req, res) => {
  const u = authUser(req);
  const l = layouts.get(req.params.id);
  if (!l || l.deletedAt) return res.status(404).json({ ok: false, error: 'Layout tidak ditemukan.' });
  if (u.role !== 'guru' && l.ownerId !== u.userId && u.userId !== 'ANON') {
    return res.status(403).json({ ok: false, error: 'Hanya guru/pemilik yang boleh publish.' });
  }
  const classId = (req.body && req.body.classId) || l.classId || u.classId;
  if (!classId) return res.status(400).json({ ok: false, error: 'classId wajib diisi.' });
  l.classId = String(classId).slice(0, 24);
  l.published = true;
  l.version += 1;
  l.updatedAt = new Date().toISOString();
  schedulePersist();
  res.json({ ok: true, item: publicLayout(l) });
});

// PRD v5.2 FR-42/46 — daftar dunia + metadata (lobby "Lanjutkan")
function worldMeta(r) {
  return {
    code: r.code, isClass: !!r.isClass, locked: !!r.locked,
    maxPlayers: r.maxPlayers, online: r.peers ? r.peers.size : 0,
    status: (r.peers && r.peers.size) ? 'active' : (r.status || 'idle'),
    itemCount: Array.isArray(r.items) ? r.items.length : 0,
    createdAt: r.createdAt || null,
    lastActivityAt: r.lastActivityAt || null,
    lastActivityBy: r.lastActivityBy || null,
    itemsUpdatedAt: r.itemsUpdatedAt || null
  };
}
app.get('/api/worlds', (req, res) => {
  const list = [...rooms.values()].map(worldMeta);
  list.sort((a, b) => (b.lastActivityAt || '').localeCompare(a.lastActivityAt || ''));
  res.json({ ok: true, count: list.length, items: list });
});
app.get('/api/worlds/resumable', (req, res) => {
  const list = [...rooms.values()].map(worldMeta);
  list.sort((a, b) => (b.lastActivityAt || '').localeCompare(a.lastActivityAt || ''));
  res.json({ ok: true, count: list.length, items: list });
});
app.get('/api/worlds/:code/state', (req, res) => {
  const code = String(req.params.code || '').toUpperCase().slice(0, 24);
  const r = rooms.get(code);
  if (!r) return res.status(404).json({ ok: false, error: 'Dunia tidak ditemukan.' });
  res.json({ ok: true, meta: worldMeta(r), items: r.items || [] });
});

// PRD v2 FR-07: roster anggota kelas + layout published kelas
app.get('/api/classes/:classId/layouts', (req, res) => {
  const cid = String(req.params.classId || '').toUpperCase().slice(0, 24);
  const list = [...layouts.values()]
    .filter(l => !l.deletedAt && l.published && String(l.classId || '').toUpperCase() === cid)
    .map(publicLayout);
  res.json({ ok: true, classId: cid, items: list });
});

app.get('/api/classes/:classId/members', (req, res) => {
  const cid = String(req.params.classId || '').toUpperCase().slice(0, 24);
  const room = rooms.get(cid);
  const members = [];
  if (room) {
    for (const p of room.peers.values()) {
      members.push({ name: p.username, color: p.color, isHost: !!p.isHost, voice: !!p.voice });
    }
  }
  res.json({ ok: true, classId: cid, count: members.length, members: members });
});

// PRD v2 §8: dokumentasi API
app.get('/api/docs', (req, res) => {
  res.json({
    ok: true, name: 'LabIPA 3D Studio API', version: '2.0',
    flags: { allowGuest: FLAGS.ALLOW_GUEST, liveEdit: FLAGS.ENABLE_LIVE_EDIT },
    auth: ['POST /api/auth/guest {name, classId?}', 'POST /api/auth/exchange {code, name?, classId?}', 'GET /api/auth/me (Bearer)'],
    layouts: [
      'GET /api/layouts?classId=&owner=me', 'GET /api/layouts/:id',
      'POST /api/layouts {name, items, classId?}', 'PUT /api/layouts/:id {version, items?, name?} (409 jika conflict)',
      'DELETE /api/layouts/:id (soft)', 'POST /api/layouts/:id/restore',
      'POST /api/layouts/:id/clone', 'POST /api/layouts/:id/publish {classId}'
    ],
    classes: ['GET /api/classes/:classId/layouts', 'GET /api/classes/:classId/members'],
    gate: ['GET /api/gate/status', 'POST /api/gate/unlock {key}', 'POST /api/gate/rotate {oldKey,newKey} (whitelist)', 'GET /api/gate/audit (gate token)', 'POST /api/gate/lock (gate token)'],
    worlds: ['GET /api/worlds', 'GET /api/worlds/resumable', 'GET /api/worlds/:code/state'],
    socket: ['room:create', 'room:join', 'room:lock(host)', 'presence:update', 'player:move(alias)',
      'world:update', 'voice:start/stop/data', 'voice:offer/answer/ice (WebRTC signaling)',
      'peer:join/leave/presence', 'player:join/leave (alias)', 'room:host', 'room:state']
  });
});

// =============================================================
// SOCKET HANDLERS
// =============================================================
io.on('connection', (socket) => {
  console.log('[+]', socket.id);
  socket.data.roomCode = null;

  // ---------- CREATE ----------
  socket.on('room:create', (data, cb) => {
    try {
      let isClass = false, code = '';
      const norm = normalizeRoomCode(data && data.code);
      if (norm.code) { code = norm.code; isClass = norm.isClass; }
      else { do { code = makeRoomCode(); } while (rooms.has(code)); }
      if (rooms.has(code)) return cb && cb({ ok: false, error: 'Kode sudah dipakai, coba lagi.' });

      const max = Math.max(2, Math.min(16, parseInt(data.maxPlayers, 10) || 6));
      const room = {
        code: code, isClass: isClass, locked: false,
        maxPlayers: isClass ? Math.max(max, 32) : max,
        hostUid: socket.id,
        items: Array.isArray(data.items) ? data.items : [],
        itemsUpdatedAt: Date.now(),
        itemsUpdatedBy: socket.id,
        createdAt: new Date().toISOString(),
        status: 'active',
        lastActivityAt: new Date().toISOString(),
        lastActivityBy: sanitizeName(data.name),
        peers: new Map()
      };
      rooms.set(code, room);
      schedulePersist();
      joinRoom(socket, room, data.name, true, data.avatar);
      console.log('[ROOM+]', code, 'by', socket.id);
      cb && cb({ ok: true, code: code, isClass: isClass });
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  // ---------- JOIN (autentikasi kode) ----------
  socket.on('room:join', (data, cb) => {
    try {
      // Terima format display "LAB-XXXX-XX" (hasil copy tombol Salin) —
      // buang prefix LAB seperti normalizeJoinCode di client, lalu ambil kode.
      let raw = String((data && data.code) || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
      if (/^LAB[A-Z0-9-]/.test(raw)) raw = raw.slice(3).replace(/^-/, '');
      // Kode acak 6 char: ambil tepat 6; kode kelas: pakai utuh (maks 24)
      let norm = normalizeRoomCode(raw);
      if (!norm.code && raw.length > 6) norm = normalizeRoomCode(raw.slice(0, 6));
      const room = rooms.get(norm.code);
      if (!room) return cb && cb({ ok: false, error: 'Room "' + norm.code + '" tidak ditemukan.' });
      if (room.locked) return cb && cb({ ok: false, error: 'Room dikunci host (403).', code: 403 });
      if (room.peers.size >= room.maxPlayers) {
        return cb && cb({ ok: false, error: 'Room penuh (' + room.peers.size + '/' + room.maxPlayers + ').' });
      }
      joinRoom(socket, room, data.name, false, data.avatar);
      console.log('[ROOM~]', norm.code, 'joined by', socket.id, '(' + room.peers.size + '/' + room.maxPlayers + ')');
      cb && cb({ ok: true, code: norm.code, isClass: !!room.isClass });
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  // ---------- ROOM LOCK (guru/host, PRD v2 FR-07) ----------
  socket.on('room:lock', (data, cb) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      if (!room) return cb && cb({ ok: false, error: 'Belum join room.' });
      const me = room.peers.get(socket.id);
      if (!me || !me.isHost) return cb && cb({ ok: false, error: 'Hanya host yang boleh mengunci.' });
      room.locked = !!(data && data.locked);
      schedulePersist();
      io.to(room.code).emit('room:locked', { locked: room.locked });
      cb && cb({ ok: true, locked: room.locked });
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  // ---------- PRESENCE ----------
  socket.on('presence:update', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.peers.get(socket.id);
    if (!p) return;
    if (typeof data.x === 'number') p.x = data.x;
    if (typeof data.y === 'number') p.y = data.y;
    if (typeof data.z === 'number') p.z = data.z;
    if (typeof data.rotY === 'number') p.rotY = data.rotY;
    if (typeof data.voice === 'boolean') p.voice = data.voice;
    socket.to(room.code).emit('peer:presence', {
      peer: socket.id,
      presence: { x: p.x, y: p.y, z: p.z, rotY: p.rotY, voice: p.voice }
    });
    // PRD v1.0 §6.2 — alias player:move
    socket.to(room.code).emit('player:move', {
      id: socket.id, position: { x: p.x, y: p.y, z: p.z }, rotation: { yaw: p.rotY }
    });
  });

  // ---------- WORLD STATE ----------
  socket.on('world:update', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (!Array.isArray(data.items)) return;
    room.items = data.items;
    room.itemsUpdatedAt = Date.now();
    room.itemsUpdatedBy = socket.id;
    room.lastActivityAt = new Date().toISOString();
    const me = room.peers.get(socket.id);
    if (me) room.lastActivityBy = me.username;
    schedulePersist();
    socket.to(room.code).emit('world:update', {
      items: room.items,
      itemsUpdatedAt: room.itemsUpdatedAt,
      itemsUpdatedBy: room.itemsUpdatedBy
    });
  });

  // =============================================================
  // VOICE CHAT — transport utama: Socket.IO PCM (low-latency);
  // signaling WebRTC (offer/answer/ice) untuk mode WebRTC opsional.
  // =============================================================
  socket.on('voice:start', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.peers.get(socket.id);
    if (p) p.voice = true;
    socket.to(room.code).emit('voice:peer-start', { peer: socket.id });
  });

  socket.on('voice:stop', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.peers.get(socket.id);
    if (p) p.voice = false;
    socket.to(room.code).emit('voice:peer-stop', { peer: socket.id });
  });

  socket.on('voice:data', (chunk) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (!chunk) return;
    socket.to(room.code).emit('voice:data', { peer: socket.id, chunk: chunk });
  });

  // PRD v1.0 §6.2 — relay signaling WebRTC antar peer
  function voiceRelay(ev, msg) {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (!msg) return;
    const payload = { from: socket.id, data: msg.data !== undefined ? msg.data : msg.sdp !== undefined ? (msg.sdp || msg) : msg };
    if (msg.sdp !== undefined && msg.data === undefined) payload.data = msg.sdp;
    if (msg.candidate !== undefined && msg.data === undefined) payload.data = msg.candidate;
    if (msg.to && room.peers.has(msg.to)) {
      io.to(msg.to).emit(ev, payload);
    } else {
      socket.to(room.code).emit(ev, payload);
    }
  }
  socket.on('voice:offer', (m) => voiceRelay('voice:offer', m));
  socket.on('voice:answer', (m) => voiceRelay('voice:answer', m));
  socket.on('voice:ice', (m) => voiceRelay('voice:ice', m));

  // ---------- DISCONNECT ----------
  socket.on('disconnect', () => {
    console.log('[-]', socket.id);
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    const wasHost = room.peers.get(socket.id)?.isHost;
    room.peers.delete(socket.id);
    socket.to(room.code).emit('peer:leave', { peer: socket.id });
    // PRD v1.0 §6.2 — alias player:leave
    socket.to(room.code).emit('player:leave', { id: socket.id });

    if (room.peers.size === 0) {
      // PRD v5.2 FR-43: dunia TETAP ADA saat 0 peserta (idle), tidak dihapus.
      // Room acak kedaluwarsa via sweep 30 hari; room kelas dipertahankan.
      room.status = 'idle';
      schedulePersist();
      console.log('[ROOM~]', room.code, '(idle, persisted)');
    } else if (wasHost) {
      const [nextSid, nextP] = room.peers.entries().next().value;
      nextP.isHost = true;
      room.hostUid = nextSid;
      io.to(room.code).emit('room:host', { peer: nextSid });
      console.log('[ROOM*]', room.code, 'host →', nextSid);
    }
  });
});

// =============================================================
// START
// =============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║  LabIPA 3D Studio · Multiplayer Server       ║');
  console.log('  ║  Listening on port ' + String(PORT).padEnd(24) + ' ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
});
