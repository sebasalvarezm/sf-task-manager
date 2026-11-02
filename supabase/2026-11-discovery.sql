-- ============================================================
-- Discovery (November 2026). Run once in the Supabase SQL editor.
-- Weekly search for new industrial VMS companies that are not in Salesforce
-- yet, through Parallel FindAll, one standing run per sub-group thesis.
-- Nothing here writes to Salesforce; Push does, on Seb's click only.
-- ============================================================

-- One row per sub-group thesis. Editable on /discovery.
CREATE TABLE IF NOT EXISTS discovery_theses (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL,
  group_name        TEXT        NOT NULL,           -- sub-group as Weekly Outreach writes it, e.g. "Rail"
  main_group        TEXT,                           -- e.g. "Logistics"
  sequence_name     TEXT,                           -- e.g. "[E] - Logistics — Rail" (shown only)
  sf_industry       TEXT,                           -- Account.Industry set on Push (open picklist)
  sf_group          TEXT,                           -- Account.Group__c set on Push (restricted picklist)
  exclude_industries JSONB      NOT NULL DEFAULT '[]'::jsonb, -- Salesforce Industry values excluded first (FindAll takes 10,000 of ~43,000)
  objective         TEXT        NOT NULL,
  match_conditions  JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- [{name, description}]
  generator         TEXT        NOT NULL DEFAULT 'core',
  weekly_share      INTEGER     NOT NULL DEFAULT 1,  -- rotation weight
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  findall_id        TEXT,                           -- the standing run, extended each week
  run_state         TEXT,                           -- last known Parallel status / termination reason
  matched_total     INTEGER     NOT NULL DEFAULT 0, -- matches on the standing run so far
  last_extended_at  TIMESTAMPTZ,
  preview           JSONB,                          -- last preview: {at, candidates:[{name,url,matched,reason}]}
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE discovery_theses ADD COLUMN IF NOT EXISTS exclude_industries JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE discovery_theses ENABLE ROW LEVEL SECURITY;

-- One row per company Discovery has surfaced, ever. The domain is the key that
-- keeps a company from being paid for (or shown) twice.
CREATE TABLE IF NOT EXISTS discovery_candidates (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  thesis_id          UUID        REFERENCES discovery_theses(id) ON DELETE SET NULL,
  findall_id         TEXT,
  candidate_id       TEXT,
  name               TEXT        NOT NULL,
  website            TEXT,
  domain             TEXT        NOT NULL UNIQUE,
  description        TEXT,
  citations          JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- [{url, title}]
  reasoning          JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- {condition: one line}
  found_week         DATE        NOT NULL,          -- Monday of the week it was found for
  status             TEXT        NOT NULL DEFAULT 'new',  -- new | in_salesforce | pushed | skipped
  in_salesforce_id   TEXT,                          -- the account it matched at dedupe
  staff              JSONB,                         -- {checked, total, byCountry, coreShare, flag, city, region, country}
  sf_account_id      TEXT,
  weekly_outreach_id UUID,
  skip_reason        TEXT,
  reviewed_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS discovery_candidates_week_idx ON discovery_candidates (found_week, status);
ALTER TABLE discovery_candidates ENABLE ROW LEVEL SECURITY;

-- Every Parallel and PDL call with what it cost. Caps and the Stats page read this.
CREATE TABLE IF NOT EXISTS vendor_calls (
  id          BIGSERIAL   PRIMARY KEY,
  vendor      TEXT        NOT NULL,                -- parallel | pdl
  action      TEXT        NOT NULL,                -- preview | create | extend | result | enrich
  thesis_id   UUID,
  week_start  DATE        NOT NULL,                -- Discovery week the call belongs to
  matches     INTEGER     NOT NULL DEFAULT 0,      -- Parallel: matches billed by this call
  credits     INTEGER     NOT NULL DEFAULT 0,      -- PDL: credits used
  cost_usd    NUMERIC(10,4) NOT NULL DEFAULT 0,
  mock        BOOLEAN     NOT NULL DEFAULT FALSE,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS vendor_calls_week_idx ON vendor_calls (vendor, week_start);
ALTER TABLE vendor_calls ENABLE ROW LEVEL SECURITY;

-- Weekly Outreach rows can now come from Discovery.
ALTER TABLE weekly_outreach DROP CONSTRAINT IF EXISTS weekly_outreach_source_check;
ALTER TABLE weekly_outreach ADD CONSTRAINT weekly_outreach_source_check
  CHECK (source IN ('tasks', 'recheck', 'manual', 'sourcing', 'outreach', 'discovery'));

-- Discovery starts paused. Caps are enforced server side, before every call.
INSERT INTO app_settings (key, value)
VALUES ('discovery_settings', '{"paused": true, "maxMatchesPerWeek": 25, "maxSpendPerWeek": 10, "matchesPerWeek": 20, "pushesPerWeek": 10, "pdlCreditsPerMonth": 100}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- The three starting theses. Shared conditions first, then the vertical.
INSERT INTO discovery_theses (name, group_name, main_group, sequence_name, sf_industry, sf_group, objective, match_conditions, weekly_share, exclude_industries)
SELECT * FROM (VALUES
  (
    'Rail', 'Rail', 'Logistics', '[E] - Logistics — Rail', 'Transport Execution - Rail', 'Transport & Logistics',
    'Find independent software companies that sell their own software to railroads, railcar owners and lessors, rail shippers or rail terminal operators.',
    '[
      {"name":"own_software","description":"The company''s main business is developing and selling its own software product (SaaS or licensed). Not IT services, consulting, staffing, resellers of other vendors'' software, marketplaces, or hardware makers where software is only a feature."},
      {"name":"rail_customers","description":"Its customers are railroads (Class 1 or short line), railcar owners and lessors, rail shippers or rail terminal operators, and the software runs rail operations: transportation management and track-and-trace, railcar fleet management, crew and workforce scheduling, gate and terminal operations, or asset visibility."},
      {"name":"hq_region","description":"Headquartered in the United States, Canada, the United Kingdom, continental Europe, Australia or New Zealand."},
      {"name":"independent","description":"Founder-owned or privately held. Not owned by private equity, not venture-backed, not a subsidiary or brand of a larger group, not publicly listed, and not acquired or merged in the last 3 years."},
      {"name":"size","description":"Roughly 20 to 200 employees, judged from the website, LinkedIn or company databases."}
    ]'::jsonb, 1,
    '["Transport Execution - Rail", "Yard, Terminal & Intermodal", "Visibility, Planning & Intelligence", "Transport Execution - Trucking", "Forwarding & Brokerage Platforms", "Warehousing & Fulfillment", "Transport Execution - Maritime", "Public Transportation", "Industrial", "ERP", "Unclassified", "Other", "Review Companies"]'::jsonb
  ),
  (
    'Safety & Compliance', 'Safety Compliance', 'Construction and Diversified Materials', '[E] - Safety & Compliance', 'Safety & Compliance', 'CDM',
    'Find independent software companies that sell their own safety, compliance or control-of-work software to industrial operators such as manufacturers, construction and engineering firms, energy producers and mines.',
    '[
      {"name":"own_software","description":"The company''s main business is developing and selling its own software product (SaaS or licensed). Not IT services, consulting, training providers, staffing, resellers of other vendors'' software, or hardware makers where software is only a feature."},
      {"name":"industrial_safety","description":"The software runs safety, compliance or control of work at industrial sites: permits-to-work, lockout tagout and isolations, inspections and audits, incident reporting, safety training and certification, contractor management, or regulatory compliance, for manufacturing, construction, engineering, energy, mining or similar operators. Not generic HR, office health and safety or consumer apps."},
      {"name":"hq_region","description":"Headquartered in the United States, Canada, the United Kingdom, continental Europe, Australia or New Zealand."},
      {"name":"independent","description":"Founder-owned or privately held. Not owned by private equity, not venture-backed, not a subsidiary or brand of a larger group, not publicly listed, and not acquired or merged in the last 3 years."},
      {"name":"size","description":"Roughly 20 to 200 employees, judged from the website, LinkedIn or company databases."}
    ]'::jsonb, 1,
    '["Safety & Compliance", "Compliance Management", "Fatigue Risk Management", "CMMS", "Maintenance", "QMS", "Facility Management", "Field Services", "Contractor Solutions", "Construction", "Energy", "Oil & Gas", "Mining", "Utility", "Industrial", "Unclassified", "Other", "Review Companies"]'::jsonb
  ),
  (
    'Process Manufacturing', 'Process Manufacturing', 'Manufacturing', '[E] - Manufacturing → Process Manufacturing', 'Manufacturing', 'Food Processing',
    'Find independent software companies that sell their own software that runs process plants in food and beverage, dairy, pulp, paper and packaging, chemicals, coatings and plastics, or nutraceuticals.',
    '[
      {"name":"own_software","description":"The company''s main business is developing and selling its own software product (SaaS or licensed). Not IT services, consulting, systems integrators, resellers of other vendors'' software, or equipment makers where software is only a feature."},
      {"name":"process_plants","description":"The software runs production in process manufacturing plants (food and beverage, dairy, pulp, paper and packaging, chemicals, coatings, plastics, nutraceuticals, co-packers): process ERP with recipe and lot control, batch or process MES, SPC and quality, LIMS, food safety and compliance (HACCP, FSMA, SQF, BRC), specification and formulation management, supplier quality, or checkweigher and fill control. Not farm or animal software, not transport or warehousing, not discrete job-shop manufacturing."},
      {"name":"hq_region","description":"Headquartered in the United States, Canada, the United Kingdom, continental Europe, Australia or New Zealand."},
      {"name":"independent","description":"Founder-owned or privately held. Not owned by private equity, not venture-backed, not a subsidiary or brand of a larger group, not publicly listed, and not acquired or merged in the last 3 years."},
      {"name":"size","description":"Roughly 20 to 200 employees, judged from the website, LinkedIn or company databases."}
    ]'::jsonb, 1,
    '["Food & Beverage", "Process Automation", "Batch Processing", "Chemistry", "Dairy", "Bakery", "Brewery", "Wine", "QMS", "Calibration Management", "Scale Management", "ERP", "Industrial", "Unclassified", "Other", "Review Companies", "Manufacturing"]'::jsonb
  )
) AS seed(name, group_name, main_group, sequence_name, sf_industry, sf_group, objective, match_conditions, weekly_share, exclude_industries)
WHERE NOT EXISTS (SELECT 1 FROM discovery_theses);
