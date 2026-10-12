-- ============================================================
-- Inbox (October 2026). Run once in the Supabase SQL editor.
-- Inbound replies to outreach, classified (positive / neutral / negative),
-- matched to a Salesforce account, with the reply draft and what was pushed
-- to Salesforce. One row per Outlook message.
-- ============================================================
CREATE TABLE IF NOT EXISTS inbox_replies (
  message_id         TEXT        PRIMARY KEY,          -- Outlook message id (latest inbound in the thread)
  conversation_id    TEXT        NOT NULL,
  subject            TEXT,
  from_name          TEXT,
  from_email         TEXT,
  from_domain        TEXT,
  received_at        TIMESTAMPTZ NOT NULL,
  preview            TEXT,                             -- first lines of their message
  thread             JSONB       NOT NULL DEFAULT '[]'::jsonb, -- [{from, email, at, mine, text}] oldest first
  has_mine           BOOLEAN     NOT NULL DEFAULT FALSE, -- thread contains a message I sent
  account_id         TEXT,
  account_name       TEXT,
  account_matched_by TEXT,                             -- domain | subject | null
  sentiment          TEXT,                             -- positive | neutral | negative | unclear
  timing_text        TEXT,                             -- "six months or so", "Q1", ...
  suggested_date     DATE,                             -- next-touch date proposed to Seb
  summary            TEXT,                             -- one line: what they said
  is_broker_intro    BOOLEAN     NOT NULL DEFAULT FALSE,
  status             TEXT        NOT NULL DEFAULT 'new', -- new | drafted | sent | skipped
  draft_body         TEXT,
  sent_at            TIMESTAMPTZ,
  sf_responded_at    TIMESTAMPTZ,                      -- when Responded / type were written
  task_id            TEXT,                             -- RCE task created or moved
  task_date          DATE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS inbox_replies_status_idx ON inbox_replies (status, received_at DESC);
CREATE INDEX IF NOT EXISTS inbox_replies_conversation_idx ON inbox_replies (conversation_id);
ALTER TABLE inbox_replies ENABLE ROW LEVEL SECURITY;
