-- ============================================================
-- Trip Planner geocode cache (October 2026). Run once in the Supabase SQL
-- editor. Safe to run more than once. The Trip Planner works without it;
-- it just looks places up again instead of reusing earlier answers.
-- ============================================================
CREATE TABLE IF NOT EXISTS geocode_cache (
  query_key          TEXT        PRIMARY KEY,  -- normalised place, e.g. "toronto" or "us_zip:50309"
  lat                DOUBLE PRECISION NOT NULL,
  lng                DOUBLE PRECISION NOT NULL,
  formatted_address  TEXT,
  provider           TEXT        NOT NULL,     -- google | openstreetmap
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE geocode_cache ENABLE ROW LEVEL SECURITY;
