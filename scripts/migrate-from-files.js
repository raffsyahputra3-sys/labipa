// scripts/migrate-from-files.js — pindahkan file-store ./data ke Postgres.
//   DATABASE_URL=... node scripts/migrate-from-files.js [--delete-after]
// File sumber: data/rooms.json, data/layouts.json, data/checkpoints.json.
const fs = require('fs');
const path = require('path');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
function read(f, fb) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch (e) { return fb; }
}
(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL dulu.'); process.exit(1); }
  let Pool;
  try { ({ Pool } = require('pg')); } catch (e) {
    console.error("Modul 'pg' belum diinstal. Jalankan: npm i pg");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const rooms = read('rooms.json', { rooms: {} });
  const layouts = read('layouts.json', { items: [] });
  const cps = read('checkpoints.json', { items: [] });
  let n = 0;
  for (const code of Object.keys(rooms.rooms || {})) {
    const r = rooms.rooms[code];
    await pool.query(
      `INSERT INTO worlds (id, class_id, status, created_at, last_activity_at, last_activity_by, item_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, last_activity_at=EXCLUDED.last_activity_at,
         last_activity_by=EXCLUDED.last_activity_by, item_count=EXCLUDED.item_count`,
      [r.code, r.isClass ? r.code : null, r.status || 'idle', r.createdAt || new Date().toISOString(),
       r.lastActivityAt || new Date().toISOString(), r.lastActivityBy || null, r.itemCount || 0]
    );
    for (const it of r.items || []) {
      await pool.query(
        `INSERT INTO world_items (world_id, item_key, pos, rot_y, stuck_surface, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [r.code, it.itemKey, JSON.stringify(it.pos || {}), it.rotY || 0, it.stuckSurface || null, null]
      );
      n++;
    }
  }
  console.log('Rooms:', Object.keys(rooms.rooms || {}).length, '| items:', n,
    '| layouts:', (layouts.items || []).length, '| checkpoints:', (cps.items || []).length);
  await pool.end();
  if (process.argv.includes('--delete-after')) {
    ['rooms.json', 'layouts.json', 'checkpoints.json'].forEach((f) => {
      try { fs.unlinkSync(path.join(DATA_DIR, f)); console.log('hapus', f); } catch (e) {}
    });
  }
  console.log('Migrasi file → Postgres selesai.');
})().catch((e) => { console.error('MIGRATE-FAIL:', e.message); process.exit(1); });
