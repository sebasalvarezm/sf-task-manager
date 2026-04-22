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
