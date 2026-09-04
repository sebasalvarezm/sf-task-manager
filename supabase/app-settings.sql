-- App settings — admin-editable configuration that must not live in code
-- Safe to run more than once in the Supabase SQL Editor.
--
-- Generic key → JSONB store. The first consumer is the outreach-quality ("BS")
-- scoring rules on the Stats page, under key 'outreach_quality_thresholds':
-- the core country list, the founded-year cutoff and the minimum headcount.
-- Keeping them here means the business rules change from the UI, not a deploy.
--
-- Until this table exists the feature still works: getQualityThresholds()
-- falls back to the defaults in lib/outreach-quality.ts, so the charts render
-- normally and only *saving* new rules fails. Same DDL is in setup.sql.

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Shared trigger function, also defined in setup.sql. Repeated here so this
-- file can be run on its own.
CREATE OR REPLACE FUNCTION jobs_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_app_settings_updated_at ON app_settings;
CREATE TRIGGER trg_app_settings_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION jobs_set_updated_at();
