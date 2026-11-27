-- Luka v. A2U Telemetry & Learning Analytics Schema (Cloudflare D1 / SQLite)
-- Privacy-first: ephemeral session IDs only, zero PII, zero raw speech transcripts or audio.

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  env TEXT NOT NULL,
  app TEXT NOT NULL,
  event TEXT NOT NULL,
  category TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  value REAL,
  meta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_event_ts ON events(event, ts);
CREATE INDEX IF NOT EXISTS idx_events_app_ts ON events(app, ts);
CREATE INDEX IF NOT EXISTS idx_events_cat_ts ON events(category, ts);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
