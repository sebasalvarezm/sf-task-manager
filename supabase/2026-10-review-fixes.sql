-- ============================================================
-- October 2026 review fixes. Run once in the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run).
-- Safe to run more than once.
-- ============================================================

-- 1. Triage: remember when a reply was sent, so "Send Reply" can't send the
--    same email twice. (The app works without this column, but without it
--    there is no server-side guard against a double send.)
ALTER TABLE email_triage ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

-- 2. Turn on Row Level Security for every table.
--    The app only talks to Supabase with the server-side service-role key,
--    which ignores RLS, so nothing in the app changes. What this does: the
--    project's public "anon" key can no longer read or change these tables,
--    most importantly the Salesforce / Outlook / Outreach tokens.
--    No policies are added on purpose: with RLS on and no policy, the anon
--    and authenticated roles get nothing.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sf_credentials', 'ms_credentials', 'outreach_credentials',
    'task_actions_log', 'email_triage', 'jobs', 'weekly_outreach',
    'account_geocache', 'starred_opportunities', 'deal_docs',
    'app_settings', 'wayback_snapshots'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;
