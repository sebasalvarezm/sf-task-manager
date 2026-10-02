-- ============================================================
-- InMail Queue (October 2026). Run once in the Supabase SQL editor.
-- Contacts who finished an E1-E5 email sequence without replying, with the
-- LinkedIn InMail drafts generated from their E1 and the sent/follow-up state.
-- ============================================================
CREATE TABLE IF NOT EXISTS inmail_queue (
  who_id             TEXT        PRIMARY KEY,          -- Salesforce Contact/Lead id
  account_id         TEXT,
  account_name       TEXT,
  contact_name       TEXT,
  first_name         TEXT,
  contact_email      TEXT,
  e5_task_id         TEXT,
  e5_sent_at         DATE,
  e1_task_id         TEXT,
  e1_body            TEXT,
  linkedin_url       TEXT,                             -- from Salesforce when a LinkedIn field exists
  navigator_url      TEXT,                             -- Sales Navigator people search for name + company
  status             TEXT        NOT NULL DEFAULT 'pending',
                     -- pending | generated | needs_review | sent | followup_sent | dismissed
  subject            TEXT,                             -- InMail subject, ready to paste
  initial_message    TEXT,
  followup_message   TEXT,
  flags              JSONB       NOT NULL DEFAULT '[]'::jsonb,
  sent_at            TIMESTAMPTZ,
  followup_sent_at   TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS inmail_queue_status_idx ON inmail_queue (status, e5_sent_at DESC);
ALTER TABLE inmail_queue ENABLE ROW LEVEL SECURITY;

-- Added after the first version; safe to run again.
ALTER TABLE inmail_queue ADD COLUMN IF NOT EXISTS subject TEXT;
