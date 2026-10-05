# LabIPA 3D Studio — Konteks untuk Claude Code

Aplikasi lab IPA 3D multiplayer (Three.js r128 + Socket.IO). Repo: `labipa`
(Express server + client statis). Bahasa: Indonesia (UI & komentar).

## Cara jalan
- `npm install && npm start` → http://localhost:3000 (`/health`)
- Landing: `public/index.html` · App 3D: `public/game.html` (file besar,
  logika inline ±6500 baris) · Modul client: `public/js/labipa-backend.js`
- Test: `npm test` (node:test, 15 test, `tests/`, tiap file spawn server
  sendiri — JANGAN jalankan paralel di port sama)
- Lint: `npm run lint` (ESLint flat, harus 0 error)
- Node lokal v24; `engines` bilang 18.x (warning EBADENGINE aman diabaikan)

## Env penting (lihat `render.yaml` untuk prod)
- `PORT`, `DATA_DIR` (default `./data`, gitignored), `GATE_REQUIRED` (default true)
- `MASTER_KEY` / `MASTER_KEY_BACKUP` / `MASTER_KEY_FILE`, `GATE_JWT_SECRET`,
  `GATE_IP_WHITELIST`, `GATE_MAX_ATTEMPTS`
- `ALLOW_GUEST`, `ENABLE_LIVE_EDIT`, `MOCK_OIDC` (default true)
- `TURN_URLS,TURN_USER,TURN_PASS` → diteruskan ke client via `/api/flags`
- `DATABASE_URL`/`REDIS_URL` → aktifkan mode Postgres (butuh `npm i pg redis`);
  tanpa itu `server/db.js` fallback file-store. Migrasi: `node scripts/migrate.js`
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

## Konvensi
- Jangan tambah dependensi native; stdlib dulu
- `console.log` = 0 di client (error/warn boleh); `LS_KEY` sudah 0
- Skema SQL prod: `db/001_init.sql`; compose: `docker-compose.yml` (coturn),
  `docker-compose.dev.yml` (pg16+redis7)
- Commit message Indonesia ringkas; JANGAN commit `data/` atau `.env`
