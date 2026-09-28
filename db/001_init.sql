-- LabIPA 3D Studio · skema produksi PostgreSQL (Sprint 1)
-- File-store JSON di ./data/ mengikuti bentuk ini agar migrasi 1:1.
-- Jalankan: psql $DATABASE_URL -f db/001_init.sql

CREATE TABLE IF NOT EXISTS worlds (
  id TEXT PRIMARY KEY,
  name TEXT,
  host_id TEXT,
  class_id TEXT,
  parent_world_id TEXT REFERENCES worlds(id),
  status TEXT CHECK (status IN ('active','idle','read-only','archived','deleted')) DEFAULT 'idle',
  config JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  last_activity_by TEXT,
  idle_since TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  archive_url TEXT,
  item_count INT DEFAULT 0,
  checkpoint_count INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS world_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id TEXT REFERENCES worlds(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  pos JSONB NOT NULL,
  rot_y NUMERIC DEFAULT 0,
  stuck_surface TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  version INT DEFAULT 1,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS world_checkpoints (
  id TEXT PRIMARY KEY,
  world_id TEXT REFERENCES worlds(id),
  name TEXT,
  trigger TEXT CHECK (trigger IN ('auto','manual','session-end','session-idle')) DEFAULT 'auto',
  items JSONB NOT NULL,
  item_count INT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
  -- immutable: tanpa UPDATE/DELETE oleh aplikasi
);

CREATE TABLE IF NOT EXISTS gate_audit (
  id TEXT PRIMARY KEY,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  event TEXT NOT NULL,
  success BOOLEAN,
  ip INET,
  user_agent TEXT,
  key_length INT,
  key_prefix TEXT,
  reason TEXT,
  attempt_number INT
);

CREATE TABLE IF NOT EXISTS gate_blocks (
  ip INET PRIMARY KEY,
  blocked_at TIMESTAMPTZ DEFAULT NOW(),
  blocked_until TIMESTAMPTZ NOT NULL,
  reason TEXT,
  attempt_count INT
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT NOW(),
  type TEXT,
  code TEXT,
  text TEXT
);

CREATE INDEX IF NOT EXISTS idx_worlds_status ON worlds (status, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_worlds_class ON worlds (class_id);
CREATE INDEX IF NOT EXISTS idx_world_items_world ON world_items (world_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_world_checkpoints_world ON world_checkpoints (world_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gate_audit_ip_time ON gate_audit (ip, timestamp DESC);
