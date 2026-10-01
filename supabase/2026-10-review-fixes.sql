-- ============================================================
-- October 2026 review fixes. Run once in the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run).
-- Safe to run more than once.
-- ============================================================

-- 1. Triage: remember when a reply was sent, so "Send Reply" can't send the
--    same email twice. (The app works without this column, but without it
--    there is no server-side guard against a double send.)
ALTER TABLE email_triage ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
