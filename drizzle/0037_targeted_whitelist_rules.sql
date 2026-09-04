ALTER TABLE IF EXISTS whitelist_rules
  ADD COLUMN IF NOT EXISTS target_rule_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE IF EXISTS whitelist_rules
  ADD COLUMN IF NOT EXISTS directions jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE IF EXISTS whitelist_rules
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS whitelist_rules_expires_at_idx
  ON whitelist_rules (expires_at);
