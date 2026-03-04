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
