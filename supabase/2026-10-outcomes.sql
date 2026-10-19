-- ============================================================
-- Outreach outcomes (October 2026). Run once in the Supabase SQL editor.
-- One row per sequence start (E1 / RCE1 / D-E1 task) with what we knew at
-- send time and what happened after: a reply in Outreach within 45 days, a
-- C1 or RCC on the account within 90 days. Built by the "outcomes_build"
-- job; the "What gets replies" page reads the saved report.
-- ============================================================
CREATE TABLE IF NOT EXISTS outreach_mailings (
  mailing_id    TEXT        PRIMARY KEY,
  prospect_id   TEXT,
  email         TEXT,
  sequence_name TEXT,
  mailing_type  TEXT,
  subject       TEXT,
  state         TEXT,
  created_at    TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  opened_at     TIMESTAMPTZ,
  replied_at    TIMESTAMPTZ,
  open_count    INTEGER     NOT NULL DEFAULT 0,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS outreach_mailings_email_idx ON outreach_mailings (email, delivered_at);
ALTER TABLE outreach_mailings ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS outreach_sends (
  sf_task_id    TEXT        PRIMARY KEY,
  account_id    TEXT        NOT NULL,
  account_name  TEXT,
  contact_email TEXT,
  sent_on       DATE        NOT NULL,
  sent_at       TIMESTAMPTZ,
  sender        TEXT,
  subject_type  TEXT        NOT NULL,
  country       TEXT,
  employees     INTEGER,
  founded       INTEGER,
  industry      TEXT,
  prior_sends   INTEGER     NOT NULL DEFAULT 0,
  weekday       INTEGER,                  -- 0 Sunday .. 6 Saturday, Eastern time
  hour_et       INTEGER,
  mailing_id    TEXT,
  sequence_name TEXT,
  subject       TEXT,
  opened        BOOLEAN,
  replied_at    TIMESTAMPTZ,
  call_on       DATE,
  responded     BOOLEAN     NOT NULL DEFAULT FALSE,
  built_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS outreach_sends_sent_on_idx ON outreach_sends (sent_on);
ALTER TABLE outreach_sends ENABLE ROW LEVEL SECURITY;

ALTER TYPE job_kind ADD VALUE IF NOT EXISTS 'outcomes_build';
