-- ============================================================
-- Outreach candidates (October 2026). Run once in the Supabase SQL editor.
-- The accounts from the "GOGOGO" report (E1 in the last year, Valstone record
-- type, 25-110 employees, core countries), each with the rules-of-engagement
-- verdict and Seb's review decision. Rebuilt by Refresh; decisions persist.
-- ============================================================
CREATE TABLE IF NOT EXISTS outreach_candidates (
  sf_account_id      TEXT        PRIMARY KEY,
  account_name       TEXT        NOT NULL,
  website            TEXT,
  account_url        TEXT,
  employees          INTEGER,
  country            TEXT,
  industry           TEXT,
  owner_name         TEXT,
  last_e1_at         DATE,
  last_e1_by         TEXT,
  sends              JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- [{date, type, by}] newest first
  rule_status        TEXT        NOT NULL DEFAULT 'eligible',    -- eligible | wait | blocked
  rule_reason        TEXT        NOT NULL DEFAULT '',
  eligible_on        DATE,
  sends_in_window    INTEGER     NOT NULL DEFAULT 0,
  screen_status      TEXT        NOT NULL DEFAULT 'pending',     -- pending | software | not_software | acquired | unclear | error
  screen_reason      TEXT,
  screen_facts       JSONB,
  screened_at        TIMESTAMPTZ,
  review_status      TEXT        NOT NULL DEFAULT 'open',        -- open | pushed | skipped
  skip_reason        TEXT,
  reviewed_at        TIMESTAMPTZ,
  weekly_outreach_id UUID,
  pushed_week_start  DATE,
  in_pool            BOOLEAN     NOT NULL DEFAULT TRUE,
  refreshed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS outreach_candidates_review_idx ON outreach_candidates (in_pool, review_status, rule_status, last_e1_at);
ALTER TABLE outreach_candidates ENABLE ROW LEVEL SECURITY;

-- Weekly Outreach rows can now come from the Outreach review screen.
ALTER TABLE weekly_outreach DROP CONSTRAINT IF EXISTS weekly_outreach_source_check;
ALTER TABLE weekly_outreach ADD CONSTRAINT weekly_outreach_source_check
  CHECK (source IN ('tasks', 'recheck', 'manual', 'sourcing', 'outreach'));

-- Background job kind for the software / acquisition prescreen.
ALTER TYPE job_kind ADD VALUE IF NOT EXISTS 'outreach_screen';
