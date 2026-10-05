# LabIPA 3D Studio — Konteks untuk Claude Code

Aplikasi lab IPA 3D multiplayer (Three.js r128 + Socket.IO). Repo: `labipa`
(Express server + client statis). Bahasa: Indonesia (UI & komentar).

## Cara jalan
- `npm install && npm start` → http://localhost:3000 (`/health`)
- Landing: `public/index.html` · App 3D: `public/game.html` (file besar,
  logika inline ±6500 baris) · Modul client: `public/js/labipa-backend.js`
- Test: `npm test` (node:test, 27 test, `tests/`, tiap file spawn server
  sendiri — JANGAN jalankan paralel di port sama). `tests/env.test.js` =
  server ber-env khusus (`MASTER_KEY`, `ARCHIVE_DIR`); socket test WAJIB
  ditutup di `after()` (kalau tidak, proses test menggantung)
- Lint: `npm run lint` (ESLint flat, harus 0 error)
- Node lokal v24; `engines` bilang 18.x (warning EBADENGINE aman diabaikan)

## Env penting (lihat `render.yaml` untuk prod)
- `PORT`, `DATA_DIR` (default `./data`, gitignored), `GATE_REQUIRED` (default true)
- `MASTER_KEY` / `MASTER_KEY_BACKUP` / `MASTER_KEY_FILE`, `GATE_JWT_SECRET`,
  `GATE_IP_WHITELIST`, `GATE_MAX_ATTEMPTS`
- `ALLOW_GUEST`, `ENABLE_LIVE_EDIT`, `MOCK_OIDC` (default true)
- `TURN_URLS,TURN_USER,TURN_PASS` → diteruskan ke client via `/api/flags`
- `DATABASE_URL` (Postgres, mis. Neon) → berkas state (`rooms/layouts/
  checkpoints/notifications.json` + arsip) DICERMINKAN ke tabel `labipa_kv`
  (dibuat otomatis) lewat `server/db.js`; saat boot `bootRestore()` mengisi
  ulang `DATA_DIR` dari database lalu `restorePersisted()`. Wajib di Render
  gratis (disk terhapus tiap tidur). Tanpa itu murni file-store. Skema
  relasional `db/001_init.sql` + `scripts/migrate*.js` BELUM dipakai server.
  Test tanpa Postgres: `LABIPA_PG_MODULE` = path driver tiruan
- `ARCHIVE_DIR` (mount S3), `OWNER_EMAIL` (notifikasi), `SSO_ISSUER` (SIAKAD asli)

## Arsitektur server (`server.js` — monolit, CommonJS)
- `MP_COLORS` 12 warna · `sanitizeName/uniqueName/sanitizeAvatar`
- Socket: `room:create/join` (kode 6-char ATAU kode kelas s/d 24 char),
  `room:lock`, `participant:role` (host-only), `presence:update` (+alias
  `player:move`), `world:update` (+alias), `voice:start/stop/data`,
  relay `voice:offer/answer/ice`, `peer:join/leave/presence`, alias
  `player:join/leave`, `room:host`, `room:state`, `world:denied`
- Presence punya `role`: host/editor/viewer. Viewer & dunia read-only/
  archived → `world:update` ditolak (`world:denied`).
- Keanggotaan room HANYA lewat `joinRoom()`/`leaveRoom()` (dipakai juga oleh
  disconnect & saat pindah room). Masuk ke dunia kosong → jadi host + kunci
  lama gugur; host keluar → penerus `role:'host'`; sesi berakhir →
  checkpoint `session-idle` (bila berubah). Handler socket harus tahan
  payload/ack rusak (`ack()`/`obj()`): exception di handler = proses mati.
  Item tanpa `itemKey`/`pos` disaring (`validItem`).
- Live Edit (`PUT /api/layouts/:id` → room kelas) hanya bila editor guru ATAU
  layout sudah dipublish — draf pribadi siswa tidak boleh menimpa dunia kelas.
- REST: `/api/auth/*` (guest/exchange/me), `/api/layouts` CRUD + 409
  optimistic lock (+`force`), clone/publish/soft-delete/restore,
  `/api/classes/:id/{layouts,members}`, `/api/gate/{status,unlock,rotate,
  audit,lock}`, `/api/worlds|/resumable|/:code/state`,
  `/api/worlds/:code/{checkpoints,fork,archive,restore}`,
  `.../checkpoints/:cid/rollback`, `.../checkpoints/:a/diff/:b`,
  `/api/notifications`, `/api/flags`, `/api/docs`
- Mock OIDC dev (RS256, tanpa dep): discovery/JWKS/login/token/userinfo;
  client pakai `game.html?sso=1` atau `?code=`
- Gate: hash scrypt + timingSafeEqual, rate-limit 5/15mnt→blokir 15mnt,
  20/jam→24jam, audit JSONL, JWT HMAC 12 jam, rotasi via file (fs.watch)
  / endpoint / `scripts/gate-cli.js` (`rotate-key|reset-key|verify-key`)
- Persistensi file `data/`: rooms, layouts, checkpoints, audit, notifikasi,
  debounce 2 dtk. Status dunia: active/idle/read-only/archived; sweep per jam
  (idle→read-only 30h→arsip 90h→hapus 180h, notif H-7/H-3/H-30, checkpoint
  session-idle, trim audit 90h). Checkpoint immutable (tanpa update/delete).
- Diff checkpoint: greedy per itemKey + posisi ≤0.5m → +N/−N/~N.
- Mailer = outbox file (`mail-outbox.jsonl`), BUKAN kirim SMTP beneran.

## Client (`game.html` inline + `labipa-backend.js`)
- `LabIPA.{Auth,Gate,Storage,Remote,Cache,Wal}` di `labipa-backend.js`;
  session di sessionStorage, antrean offline + WAL IndexedDB
  (`labipa-wal`: `ops` + `drafts` keyPath sessionId), autosave 30 dtk,
  indikator `#saveState` (saving/saved/offline)
- Ghost placement WAJIB = model final: `def.make()` + `applyGhostStyle()`
  (upgrade GLB async ikut di-style). JANGAN kembalikan early-return ghost
  di `placeProp`/`finishGLBUpgrade`
- Roster `#mpPlayers` (escape via `escName`), minimap dot peer,
  `labipa.playerName` kanonis, modal Detail dunia + modal konflik 409,
  banner `#gateBanner`/`#netBanner`, overlay `#gateOverlay`
- Voice default Socket.IO PCM; WebRTC mesh hanya bila `?webrtc=1`;
  `VOICE_CONFIG` diexpose ke `window` untuk injeksi TURN
- Reconnect: `mpAutoRejoin()` dipanggil dari event `connect` (Socket.IO v4:
  `reconnect` hanya ada di Manager `socket.io`, BUKAN di socket) dan selalu
  `room:join` dulu — `room:create` hanya bila dunia hilang di server.
  `mpLeaveRoom()` = `disconnect()` lalu `connect()` lagi
- Masuk game = pindah halaman: `index.html` → `game.html?mode=solo|create|
  join&name=&room=&max=` (TANPA iframe/overlay). Kode ruangan pakai `?room=`,
  BUKAN `?code=` (itu milik SSO). Setelah `room:state` URL ditulis ulang jadi
  `?mode=join&room=KODE` → refresh = masuk ruangan yang sama. Kode ruangan
  tampil di SATU tempat: chip topbar `#mpChip` (`#mpCopyCode` salin,
  `#mpChipToggle` buka `#mpPanel`). Keluar room dari alur studio → `index.html`
- Gate: `Gate.check()` selalu tanya `/api/gate/status`; bila
  `GATE_REQUIRED=false` → `isLocked()` false & overlay tidak muncul
- Antrean offline (`LS_QUEUE`) hanya menyimpan snapshot TERBARU; `flushQueue`
  membuang op setelah server menerima (bukan sebelum mencoba)

## Konvensi
- Jangan tambah dependensi native; stdlib dulu
- `console.log` = 0 di client (error/warn boleh); `LS_KEY` sudah 0
- Skema SQL prod: `db/001_init.sql`; compose: `docker-compose.yml` (coturn),
  `docker-compose.dev.yml` (pg16+redis7)
- Commit message Indonesia ringkas; JANGAN commit `data/` atau `.env`
