ALTER TABLE IF EXISTS policy_dimension_config
  ADD COLUMN IF NOT EXISTS created_at timestamptz;

UPDATE policy_dimension_config
SET created_at = now()
WHERE created_at IS NULL;

ALTER TABLE IF EXISTS policy_dimension_config
  ALTER COLUMN created_at SET DEFAULT now();

ALTER TABLE IF EXISTS policy_dimension_config
  ALTER COLUMN created_at SET NOT NULL;
