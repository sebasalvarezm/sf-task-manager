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
