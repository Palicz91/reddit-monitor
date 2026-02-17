-- Run this in Supabase SQL Editor (https://supabase.com/dashboard > SQL Editor)

-- Daily draft counter
CREATE TABLE IF NOT EXISTS reddit_monitor_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  run_date TEXT NOT NULL DEFAULT '',
  drafts_sent INTEGER NOT NULL DEFAULT 0
);

INSERT INTO reddit_monitor_state (id, run_date, drafts_sent)
VALUES (1, '', 0)
ON CONFLICT (id) DO NOTHING;

-- Seen posts (prevents duplicate drafts)
CREATE TABLE IF NOT EXISTS reddit_seen_posts (
  permalink TEXT PRIMARY KEY,
  seen_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seen_at ON reddit_seen_posts(seen_at);
