-- Pan's Mega Repo — D1 Relational Schema & Migrations

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bundle_identifier TEXT NOT NULL,
  original_bundle_identifier TEXT NOT NULL,
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  download_url TEXT NOT NULL DEFAULT '',
  icon_url TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_apps_bundle_id ON applications(bundle_identifier);

CREATE TABLE IF NOT EXISTS asset_fingerprints (
  sha TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  url TEXT NOT NULL,
  dhash TEXT NOT NULL,
  ahash TEXT NOT NULL,
  rgb_vector TEXT NOT NULL,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS source_backups (
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  content_base64 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);