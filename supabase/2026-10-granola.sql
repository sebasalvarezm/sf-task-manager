-- ============================================================
-- Granola in the Call Logger (October 2026).
-- Run once in the Supabase SQL editor (Dashboard → SQL Editor → New query
-- → paste → Run). Safe to run more than once.
--
-- Privacy: these tables only ever hold notes for meetings that are rows in
-- the Call Logger (external meetings on your calendar). Notes for internal
-- or unmatched meetings are never stored. Transcripts are never stored:
-- they are read from Granola when you open them, or when a suggestion is
-- written.
-- ============================================================

-- 1. Granola notes matched to Call Logger meetings (one note per meeting).
CREATE TABLE IF NOT EXISTS granola_notes (
  granola_note_id  TEXT        PRIMARY KEY,          -- e.g. not_1d3tmYTlCICgjy (dedupe key)
  event_id         TEXT        NOT NULL,             -- Outlook calendar event id
  meeting_date     DATE        NOT NULL,             -- same date the Call Logger shows
  meeting_start    TIMESTAMPTZ,
  title            TEXT,
  summary          TEXT        NOT NULL DEFAULT '',  -- Granola's AI summary (markdown)
  web_url          TEXT,
  matched_by       TEXT        NOT NULL,             -- calendar_event | time_and_attendees | time_and_title
  note_updated_at  TIMESTAMPTZ,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS granola_notes_event_id_key ON granola_notes (event_id);
CREATE INDEX IF NOT EXISTS granola_notes_meeting_date_idx ON granola_notes (meeting_date);
ALTER TABLE granola_notes ENABLE ROW LEVEL SECURITY;

-- 2. Suggested Call Logger fields per meeting (item 4). Regenerated when the
--    Granola note changes. Nothing here is logged to Salesforce on its own.
CREATE TABLE IF NOT EXISTS call_suggestions (
  event_id          TEXT        PRIMARY KEY,         -- Outlook calendar event id
  granola_note_id   TEXT,                            -- null when made from pasted notes
  note_updated_at   TIMESTAMPTZ,                     -- Granola version it was made from
  meeting_date      DATE        NOT NULL,
  commentary        TEXT,
  call_type         TEXT,                            -- C1 | RCC | null
  type_reason       TEXT,
  follow_up_days    INTEGER,                         -- RCE number; null = none
  follow_up_reason  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS call_suggestions_meeting_date_idx ON call_suggestions (meeting_date);
ALTER TABLE call_suggestions ENABLE ROW LEVEL SECURITY;

-- 3. Your edits to suggestions (item 5): what was suggested and what you
--    logged instead, one row per logged meeting. Future suggestions use your
--    corrected versions as their first examples.
CREATE TABLE IF NOT EXISTS call_suggestion_corrections (
  event_id                  TEXT        PRIMARY KEY,
  granola_note_id           TEXT,
  account_name              TEXT,
  meeting_date              DATE,
  suggested_commentary      TEXT,
  final_commentary          TEXT,
  suggested_call_type       TEXT,
  final_call_type           TEXT,
  suggested_follow_up_days  INTEGER,
  final_follow_up_days      INTEGER,
  changed_fields            TEXT[]      NOT NULL DEFAULT '{}',  -- commentary / callType / followUp
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS call_suggestion_corrections_created_idx ON call_suggestion_corrections (created_at DESC);
ALTER TABLE call_suggestion_corrections ENABLE ROW LEVEL SECURITY;
