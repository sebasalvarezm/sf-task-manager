-- Year founded on Outreach pool accounts, for "factor fit" ranking and the
-- founded sort (Nov 2026). Safe to run more than once. After running it,
-- click "Rebuild the pool from Salesforce" once to fill it in.
alter table outreach_candidates add column if not exists founded integer;
