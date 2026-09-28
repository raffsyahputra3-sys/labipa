// scripts/migrate.js — jalankan migrasi SQL di db/*.sql ke Postgres.
//   DATABASE_URL=... node scripts/migrate.js
// Tanpa DATABASE_URL: mode dry-run (validasi file ada & terbaca).
const fs = require('fs');
const path = require('path');
(async () => {
  const dir = path.join(__dirname, '..', 'db');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (!files.length) { console.error('Tidak ada file migrasi di db/.'); process.exit(1); }
  if (!process.env.DATABASE_URL) {
    console.log('DRY-RUN (DATABASE_URL kosong):');
    files.forEach((f) => console.log('  -', f, '(' + fs.statSync(path.join(dir, f)).size + ' byte)'));
    console.log('Set DATABASE_URL untuk migrasi beneran.');
    process.exit(0);
  }
  let Pool;
  try { ({ Pool } = require('pg')); } catch (e) {
    console.error("Modul 'pg' belum diinstal. Jalankan: npm i pg");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    console.log('Migrasi', f, '...');
    await pool.query(sql);
    console.log('  OK');
  }
  await pool.end();
  console.log('Semua migrasi selesai.');
})().catch((e) => { console.error('MIGRATE-FAIL:', e.message); process.exit(1); });
