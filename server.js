// =============================================================
// LabIPA 3D Studio · Socket.IO Multiplayer + Voice Chat Server
// =============================================================
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// CORS: izinkan semua origin (aman untuk kelas, ganti kalau perlu)
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e6,   // 1 MB — cukup untuk chunk voice
  pingTimeout: 25000,
  pingInterval: 20000
});

app.use(express.static(path.join(__dirname, 'public')));

// Health check untuk cron-job.org
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// =============================================================
// ROOM STATE (in-memory)
// =============================================================
const rooms = new Map();
const MP_COLORS = [
  '#3D7EA6', '#D97706', '#2E5C3E', '#8B1E1E',
  '#6B4FA0', '#C2410C', '#0E7490', '#A16207'
];

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function peersPublic(room) {
  const out = [];
  for (const [sid, p] of room.peers) {
    out.push({ peer: sid, isMe: false, presence: p, isHost: !!p.isHost });
  }
  return out;
}

function joinRoom(socket, room, name, isHost) {
  socket.join(room.code);
  socket.data.roomCode = room.code;

  const color = MP_COLORS[room.peers.size % MP_COLORS.length];

  const presence = {
    uid: socket.id,
    username: (name || 'Pemain').slice(0, 16),
    color: color,
    isHost: !!isHost,
    voice: false,
    x: 1, y: 1.6, z: 6, rotY: 0
  };
  room.peers.set(socket.id, presence);

  socket.emit('room:state', {
    code: room.code,
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
}

// =============================================================
// SOCKET HANDLERS
// =============================================================
io.on('connection', (socket) => {
  console.log('[+]', socket.id);
  socket.data.roomCode = null;

  // ---------- CREATE ----------
  socket.on('room:create', (data, cb) => {
    try {
      let code = (data && data.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (!code) code = makeRoomCode();
      if (rooms.has(code)) return cb && cb({ ok: false, error: 'Kode sudah dipakai, coba lagi.' });

      const max = Math.max(2, Math.min(16, parseInt(data.maxPlayers, 10) || 6));
      const room = {
        code: code,
        maxPlayers: max,
        hostUid: socket.id,
        items: Array.isArray(data.items) ? data.items : [],
        itemsUpdatedAt: Date.now(),
        itemsUpdatedBy: socket.id,
        peers: new Map()
      };
      rooms.set(code, room);
      joinRoom(socket, room, data.name, true);
      console.log('[ROOM+]', code, 'by', socket.id);
      cb && cb({ ok: true, code: code });
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  // ---------- JOIN ----------
  socket.on('room:join', (data, cb) => {
    try {
      const code = (data && data.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return cb && cb({ ok: false, error: 'Room "' + code + '" tidak ditemukan.' });
      if (room.peers.size >= room.maxPlayers) {
        return cb && cb({ ok: false, error: 'Room penuh (' + room.peers.size + '/' + room.maxPlayers + ').' });
      }
      joinRoom(socket, room, data.name, false);
      console.log('[ROOM~]', code, 'joined by', socket.id, '(' + room.peers.size + '/' + room.maxPlayers + ')');
      cb && cb({ ok: true, code: code });
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
  // VOICE CHAT
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

  // ---------- DISCONNECT ----------
  socket.on('disconnect', () => {
    console.log('[-]', socket.id);
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    const wasHost = room.peers.get(socket.id)?.isHost;
    room.peers.delete(socket.id);
    socket.to(room.code).emit('peer:leave', { peer: socket.id });

    if (room.peers.size === 0) {
      rooms.delete(room.code);
      console.log('[ROOM-]', room.code, '(empty)');
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
