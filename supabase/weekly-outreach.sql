-- Weekly Outreach tracker
-- Safe to run more than once in the Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS weekly_outreach (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start DATE NOT NULL,
  outreach_type TEXT NOT NULL CHECK (outreach_type IN ('E1', 'RCE')),
  sf_account_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_url TEXT,
  website TEXT,
  industry TEXT,
  country TEXT,
  city TEXT,
  tier TEXT,
  group_name TEXT,
  source TEXT NOT NULL CHECK (source IN ('tasks', 'recheck', 'manual', 'sourcing')),
  source_reference TEXT,
  rce_days INTEGER,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'needs_context', 'researching', 'draft_ready', 'approved', 'sent')),
  context_summary TEXT,
  draft TEXT,
  notes TEXT,
  sourcing_job_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (week_start, sf_account_id, outreach_type)
);

CREATE INDEX IF NOT EXISTS idx_weekly_outreach_week
  ON weekly_outreach (week_start DESC, created_at ASC);

CREATE OR REPLACE FUNCTION jobs_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_weekly_outreach_updated_at ON weekly_outreach;
CREATE TRIGGER trg_weekly_outreach_updated_at
  BEFORE UPDATE ON weekly_outreach
  FOR EACH ROW EXECUTE FUNCTION jobs_set_updated_at();
