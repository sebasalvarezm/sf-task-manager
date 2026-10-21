-- Hook provenance on send rows: what the opening sentence rests on and how
-- far to trust it. Filled by the prepare job; re-prepare existing rows to
-- populate it.
alter table e1_sends add column if not exists hook jsonb;
alter table e1_sends add column if not exists restaurant_options jsonb not null default '[]'::jsonb;
