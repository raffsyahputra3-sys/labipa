// LabIPA DB adapter (Sprint 1 / C.3). Produksi: set DATABASE_URL (+REDIS_URL)
// dan `npm i pg redis`, lalu `node scripts/migrate.js`.
// Tanpa env tersebut server otomatis memakai file-store ./data/
// (bentuk data 1:1 dengan db/001_init.sql) — tanpa ubah kode lain.
let pool = null;
let cache = null;
let pgAvailable = false;
try {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000
    });
    pgAvailable = true;
  }
} catch (e) {
  console.log('[DB] modul pg tidak ada — pakai file-store. (`npm i pg` untuk Postgres)');
}
try {
  if (process.env.REDIS_URL) {
    const { createClient } = require('redis');
    cache = createClient({ url: process.env.REDIS_URL });
    cache.on('error', () => {});
    cache.connect().catch(() => { cache = null; });
  }
} catch (e) {
  console.log('[DB] modul redis tidak ada — cache nonaktif. (`npm i redis` untuk Redis)');
}
module.exports = {
  pool,
  cache,
  get mode() { return pgAvailable ? 'postgres' : 'file'; },
  async ping() {
    if (!pool) return { mode: 'file', ok: true };
    try { await pool.query('SELECT 1'); return { mode: 'postgres', ok: true }; }
    catch (e) { return { mode: 'postgres', ok: false, error: e.message }; }
  }
};
