// LabIPA DB adapter. Set DATABASE_URL (Postgres, mis. Neon/Supabase) →
// berkas state (rooms/layouts/checkpoints/notifikasi/arsip) DICERMINKAN ke
// tabel labipa_kv, sehingga dunia tetap ada walau disk host terhapus
// (Render paket gratis). Tanpa DATABASE_URL: murni file-store ./data/.
// Server tetap membaca/menulis file seperti biasa; saat boot file diisi
// ulang dari database (lihat bootRestore di server.js).
let pool = null;
try {
  if (process.env.DATABASE_URL) {
    // LABIPA_PG_MODULE: driver pengganti untuk test (tanpa Postgres sungguhan)
    const { Pool } = require(process.env.LABIPA_PG_MODULE || 'pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000 });
    if (pool.on) pool.on('error', (e) => console.error('[DB] koneksi idle error:', e.message));
  }
} catch (e) {
  console.error('[DB] DATABASE_URL di-set tapi modul pg gagal dimuat — pakai file-store saja:', e.message);
  pool = null;
}

const lastSaved = new Map(); // key -> JSON terakhir yang terkirim (lewati tulis yang sama)
let chain = Promise.resolve(); // tulis berurutan: snapshot lama tak boleh menimpa yang baru

module.exports = {
  get mode() { return pool ? 'postgres' : 'file'; },
  async ping() {
    if (!pool) return { mode: 'file', ok: true };
    try { await pool.query('SELECT 1'); return { mode: 'postgres', ok: true }; }
    catch (e) { return { mode: 'postgres', ok: false, error: e.message }; }
  },
  async init() {
    if (!pool) return;
    await pool.query('CREATE TABLE IF NOT EXISTS labipa_kv (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
  },
  // → objek hasil parse, atau null bila belum ada
  async get(key) {
    if (!pool) return null;
    const r = await pool.query('SELECT value FROM labipa_kv WHERE key = $1', [key]);
    if (!r.rows || !r.rows.length) return null;
    lastSaved.set(key, r.rows[0].value);
    return JSON.parse(r.rows[0].value);
  },
  // Tidak menunggu: dipanggil dari jalur sinkron (persistAll). Gagal → dicatat,
  // dan snapshot berikutnya akan mencoba lagi.
  put(key, obj) {
    if (!pool) return;
    const json = JSON.stringify(obj);
    if (lastSaved.get(key) === json) return;
    lastSaved.set(key, json);
    chain = chain.then(() => pool.query(
      'INSERT INTO labipa_kv (key, value, updated_at) VALUES ($1, $2, now()) ' +
      'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', [key, json]
    )).catch((e) => {
      if (lastSaved.get(key) === json) lastSaved.delete(key);
      console.error('[DB] gagal menyimpan', key, '-', e.message);
    });
  },
  // Selesaikan semua tulis yang masih antre (dipakai saat shutdown)
  flush() { return chain; }
};
