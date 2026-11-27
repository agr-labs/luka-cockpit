-- Cloudflare D1 migration: Beat the Bot synchronized multiplayer rooms on public Pages deploys.
CREATE TABLE IF NOT EXISTS game_rooms (
  code TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  state_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_rooms_updated ON game_rooms(updated_at);
