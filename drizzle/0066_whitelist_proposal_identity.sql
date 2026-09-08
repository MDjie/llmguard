-- Unknown legacy proposers cannot be independently approved until resubmitted.
ALTER TABLE whitelist_rules ADD COLUMN IF NOT EXISTS proposed_by varchar(100);
ALTER TABLE whitelist_rules ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE whitelist_rules ALTER COLUMN enabled SET DEFAULT false;
