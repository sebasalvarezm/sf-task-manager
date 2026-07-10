-- ============================================================
-- Salesforce Task Manager — Supabase Database Setup
-- ============================================================
-- Run this entire script in the Supabase SQL Editor.
-- How to get there: Supabase Dashboard → SQL Editor → New Query
-- Paste everything below, then click "Run".
-- ============================================================

-- Table 1: Salesforce OAuth Tokens
-- Stores the connection credentials so you don't have to re-connect every time.
CREATE TABLE IF NOT EXISTS sf_credentials (
  id TEXT PRIMARY KEY DEFAULT 'default',
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  instance_url TEXT NOT NULL,
  salesforce_user_id TEXT,
  token_issued_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table 2: Action History Log
-- Records every action you take (delete, reschedule, delay) for your own records.
CREATE TABLE IF NOT EXISTS task_actions_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id TEXT NOT NULL,
  account_name TEXT,
  action_type TEXT NOT NULL CHECK (action_type IN ('hard_delete', 'complete_reschedule', 'delay')),
  days_used INTEGER,
  old_date DATE,
  new_date DATE,
  executed_at TIMESTAMPTZ DEFAULT NOW(),
  success BOOLEAN NOT NULL DEFAULT true,
  error_message TEXT
);

-- Index to make date-range queries on the log faster
CREATE INDEX IF NOT EXISTS idx_task_actions_log_executed_at
  ON task_actions_log (executed_at DESC);

-- ============================================================
-- Table 3: Microsoft OAuth Tokens (for Outlook Calendar)
-- ============================================================
-- Stores the Microsoft connection so the Call Logger can read your calendar.
CREATE TABLE IF NOT EXISTS ms_credentials (
  id TEXT PRIMARY KEY DEFAULT 'default',
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_issued_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Table 4: Email Triage (for the Email Triage dashboard)
-- ============================================================
-- Stores AI-categorized emails from the morning triage scan.
-- The Cowork scheduled task writes rows here; the dashboard reads them.
CREATE TABLE IF NOT EXISTS email_triage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  triage_date DATE NOT NULL,

  -- Email metadata
  email_id TEXT,                    -- Outlook message ID (for dedup)
  sender_name TEXT NOT NULL,
  sender_email TEXT,
  subject TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('p1', 'p2', 'p3')),

  -- Categorization
  context TEXT,                     -- One-line summary of why it matters
  flag_note TEXT,                   -- If flagged for personal attention
  is_flagged BOOLEAN DEFAULT false,

  -- Thread data (JSON array of messages)
  thread JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Draft
  draft TEXT,                       -- The AI-drafted reply (null if no draft)

  -- Review status (set by the dashboard UI)
  review_status TEXT CHECK (review_status IN ('pending', 'approved', 'edited', 'rejected')),
  edited_draft TEXT,                -- If user edited the draft, store revised version
  reviewed_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast daily lookups
CREATE INDEX IF NOT EXISTS idx_email_triage_date ON email_triage (triage_date DESC);

-- Unique constraint to prevent duplicate emails on the same day
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_triage_dedup
  ON email_triage (triage_date, email_id) WHERE email_id IS NOT NULL;

-- ============================================================
-- Table 5: Outreach.io OAuth Tokens (for Outreach Queue tool)
-- ============================================================
-- Stores the Outreach.io connection so the Outreach Queue can read
-- sequences and push prospects without re-authenticating each time.
CREATE TABLE IF NOT EXISTS outreach_credentials (
  id TEXT PRIMARY KEY DEFAULT 'default',
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_issued_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Table 6: Account Geocache (for Trip Planner)
-- ============================================================
-- Caches lat/lng coordinates for Salesforce accounts to avoid re-geocoding.
-- The Trip Planner geocodes accounts once (via Google Maps + Places API),
-- then reads from this cache on every search.
CREATE TABLE IF NOT EXISTS account_geocache (
  sf_account_id TEXT PRIMARY KEY,
  account_name TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  formatted_address TEXT,
  address_source TEXT NOT NULL CHECK (address_source IN ('billing', 'places', 'manual')),
  geocoded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_geocache_coords
  ON account_geocache (lat, lng);

-- ============================================================
-- Table 7: Background Jobs Queue
-- ============================================================
-- Tracks long-running operations (sourcing scrapes, AI prep one-pagers,
-- bulk task actions) so the UI can show progress in the notification bell
-- and you can navigate away while work continues. Without this, every
-- long operation blocks the page and dies if you click somewhere else.

DO $$ BEGIN
  CREATE TYPE job_kind AS ENUM ('sourcing', 'prep', 'task_bulk', 'trip_geocode');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Additional job kinds added incrementally; ALTER TYPE ADD VALUE is idempotent
-- via IF NOT EXISTS so this section is safe to re-run.
ALTER TYPE job_kind ADD VALUE IF NOT EXISTS 'trip_search';
ALTER TYPE job_kind ADD VALUE IF NOT EXISTS 'calls_log';
ALTER TYPE job_kind ADD VALUE IF NOT EXISTS 'accounts_enrich';
ALTER TYPE job_kind ADD VALUE IF NOT EXISTS 'sourcing_bulk';

DO $$ BEGIN
  CREATE TYPE job_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL DEFAULT 'default',
  kind job_kind NOT NULL,
  status job_status NOT NULL DEFAULT 'queued',
  label TEXT,                              -- friendly name shown in the bell, e.g. "Sourcing: acme.com"
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,                            -- populated on success
  error TEXT,                              -- populated on failure
  progress JSONB DEFAULT '{}'::jsonb,      -- optional: {"step":"history","pct":40}
  inngest_run_id TEXT,                     -- for debugging; ties back to Inngest dashboard
  result_route TEXT,                       -- deep-link the bell uses, e.g. "/sourcing?domain=acme.com"
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  seen_at TIMESTAMPTZ                      -- when the user dismissed the red dot
);

CREATE INDEX IF NOT EXISTS idx_jobs_session_created
  ON jobs (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_status_active
  ON jobs (status) WHERE status IN ('queued', 'running');

CREATE OR REPLACE FUNCTION jobs_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jobs_updated_at ON jobs;
CREATE TRIGGER trg_jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_set_updated_at();

-- ============================================================
-- Table 8: Deal Docs (uploaded memo/teaser per company + AI metrics)
-- ============================================================
-- Stores ONE current document per Salesforce account (replace-only — a new
-- upload overwrites the old). The Stats pipeline drill-down shows a "File"
-- column to upload, open, replace, and view 7 AI-extracted metrics.
--
-- IMPORTANT — one-time Storage setup (do this once, separate from this SQL):
--   Supabase Dashboard → Storage → New bucket
--     • Name:   deal-docs
--     • Public: OFF  (keep it private — files are served via short-lived
--                     signed URLs minted server-side)
--   (Or run:  insert into storage.buckets (id, name, public)
--             values ('deal-docs','deal-docs', false) on conflict do nothing;)
-- No Storage RLS policies are needed: all access goes through the
-- service-role client (getSupabaseAdmin), which bypasses RLS.

CREATE TABLE IF NOT EXISTS deal_docs (
  sf_account_id     TEXT PRIMARY KEY,
  account_name      TEXT,
  storage_path      TEXT NOT NULL,          -- e.g. "001xx.../current.pdf"
  filename          TEXT NOT NULL,          -- original upload name (display + download)
  mime_type         TEXT NOT NULL,
  file_size         BIGINT,

  -- 7 AI/manual metrics — all free-text (values may be ranges, "~$5M", "N/A")
  hq                TEXT,
  rev_usd           TEXT,
  arr_usd           TEXT,
  ebitda            TEXT,
  num_customers     TEXT,
  growth_rate       TEXT,
  churn             TEXT,

  extraction_status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (extraction_status IN ('pending', 'done', 'failed', 'skipped')),
  uploaded_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Bump updated_at on every change (reuses the jobs trigger function)
DROP TRIGGER IF EXISTS trg_deal_docs_updated_at ON deal_docs;
CREATE TRIGGER trg_deal_docs_updated_at
  BEFORE UPDATE ON deal_docs
  FOR EACH ROW EXECUTE FUNCTION jobs_set_updated_at();

-- ============================================================
-- Table 9: Starred Opportunities ("star leads")
-- ============================================================
-- Tracks which BRO opportunities the user has flagged as important. Presence
-- of a row = starred; deleted row = un-starred. Used by the Stats drill-down
-- to highlight starred rows in yellow. Single-tenant app, so no user_id.

CREATE TABLE IF NOT EXISTS starred_opportunities (
  sf_opportunity_id TEXT PRIMARY KEY,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
