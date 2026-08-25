-- Wayback Machine snapshot cache
-- Safe to run more than once in the Supabase SQL Editor.
--
-- An archived page at a fixed Wayback timestamp never changes, so a downloaded
-- page (or a permanent verdict such as "parked page") can be reused forever.
-- This is what stops Archive.org's rate limit from breaking repeat sourcing
-- runs. Transport failures such as HTTP 429 are never stored.

CREATE TABLE IF NOT EXISTS wayback_snapshots (
  archive_url TEXT PRIMARY KEY,
  snapshot_text TEXT,
  skip_reason TEXT,
  failure_type TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
