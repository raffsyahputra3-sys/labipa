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
const { Server } = require('socket.io');

const app = express();
app.use(express.json({ limit: '2mb' }));
const server = http.createServer(app);

// ---------- Feature flags (PRD v2 §7.4) ----------
const FLAGS = {
  ALLOW_GUEST: process.env.ALLOW_GUEST !== 'false', // default true utk demo
  ENABLE_LIVE_EDIT: process.env.ENABLE_LIVE_EDIT !== 'false',
  SSO_ISSUER: process.env.SSO_ISSUER || '',
  SSO_CLIENT_ID: process.env.SSO_CLIENT_ID || 'labipa-3d-studio'
};

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
  res.json({ ok: true, restoreUntilDays: 30 });
});

app.post('/api/layouts/:id/restore', (req, res) => {
  const l = layouts.get(req.params.id);
  if (!l || !l.deletedAt) return res.status(404).json({ ok: false, error: 'Layout tidak ditemukan / tidak terhapus.' });
  l.deletedAt = null;
  l.updatedAt = new Date().toISOString();
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
  res.json({ ok: true, item: publicLayout(l) });
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
        peers: new Map()
      };
      rooms.set(code, room);
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
      // Room kelas (SIAKAD) dipertahankan 15 mnt setelah sesi berakhir (FR-07);
      // room acak dihapus langsung saat kosong.
      if (room.isClass) {
        setTimeout(() => {
          const r = rooms.get(room.code);
          if (r && r.peers.size === 0) { rooms.delete(room.code); console.log('[ROOM-]', room.code, '(class expired)'); }
        }, 15 * 60 * 1000);
      } else {
        rooms.delete(room.code);
        console.log('[ROOM-]', room.code, '(empty)');
      }
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
