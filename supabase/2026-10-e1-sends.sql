-- Send queue: every sourced E1 on its way from "draft ready" to a scheduled
-- Outreach mailing. One row per company per week. Run once in the Supabase SQL
-- editor.

CREATE TABLE IF NOT EXISTS e1_sends (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start           DATE        NOT NULL,
  weekly_outreach_id   UUID        UNIQUE,
  sourcing_job_id      UUID,
  sf_account_id        TEXT        NOT NULL,
  account_name         TEXT        NOT NULL,
  website              TEXT,
  country              TEXT,
  state                TEXT,
  city                 TEXT,
  group_name           TEXT,
  -- Outreach sequence the group maps to (null until matched or picked by hand)
  sequence_id          TEXT,
  sequence_name        TEXT,
  -- contact to email, proposed by title rank and confirmable by hand
  contact_id           TEXT,
  contact_name         TEXT,
  contact_first_name   TEXT,
  contact_last_name    TEXT,
  contact_title        TEXT,
  contact_email        TEXT,
  contact_options      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- QuickEmailVerification verdict for contact_email
  verify_result        TEXT,       -- valid | invalid | unknown | accept_all | role | disposable | error
  verify_detail        JSONB,
  verified_email       TEXT,       -- the address the verdict is for; re-verify when it changes
  -- model review of the draft (flag only, never edits)
  review_flags         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  reviewed_at          TIMESTAMPTZ,
  subject              TEXT,
  body                 TEXT,
  -- pending | review | ready | approved | scheduling | dry_run | scheduled | sent | failed | rejected
  status               TEXT        NOT NULL DEFAULT 'pending',
  status_reason        TEXT,
  scheduled_for        TIMESTAMPTZ,
  time_zone            TEXT,
  outreach_prospect_id TEXT,
  outreach_state_id    TEXT,
  outreach_task_id     TEXT,
  outreach_mailing_id  TEXT,
  approved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS e1_sends_week_idx   ON e1_sends (week_start);
CREATE INDEX IF NOT EXISTS e1_sends_status_idx ON e1_sends (status);
CREATE INDEX IF NOT EXISTS e1_sends_acct_idx   ON e1_sends (sf_account_id, created_at DESC);

ALTER TYPE job_kind ADD VALUE IF NOT EXISTS 'e1_prepare';
ALTER TYPE job_kind ADD VALUE IF NOT EXISTS 'e1_schedule';

-- Model spend, one row per call, so the app can say what each feature costs.
CREATE TABLE IF NOT EXISTS model_calls (
  id            BIGSERIAL PRIMARY KEY,
  feature       TEXT        NOT NULL,
  model         TEXT        NOT NULL,
  input_tokens  INTEGER     NOT NULL DEFAULT 0,
  output_tokens INTEGER     NOT NULL DEFAULT 0,
  cache_read    INTEGER     NOT NULL DEFAULT 0,
  cache_write   INTEGER     NOT NULL DEFAULT 0,
  searches      INTEGER     NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(10,5) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_calls_created_idx ON model_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS model_calls_feature_idx ON model_calls (feature, created_at DESC);
