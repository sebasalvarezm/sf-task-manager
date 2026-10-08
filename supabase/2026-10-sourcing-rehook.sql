-- Deep research this hook now runs as a background job. Run once in the
-- Supabase SQL editor; safe to run again.
ALTER TYPE job_kind ADD VALUE IF NOT EXISTS 'sourcing_rehook';
