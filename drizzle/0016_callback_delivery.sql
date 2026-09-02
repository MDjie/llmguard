BEGIN;

ALTER TABLE guard_jobs ADD COLUMN IF NOT EXISTS callback_attempt integer NOT NULL DEFAULT 0;
ALTER TABLE guard_jobs ADD COLUMN IF NOT EXISTS callback_next_at timestamptz;
ALTER TABLE guard_jobs ADD COLUMN IF NOT EXISTS callback_last_error varchar(500);
CREATE INDEX IF NOT EXISTS guard_jobs_callback_delivery_idx
  ON guard_jobs (callback_state, callback_next_at)
  WHERE callback_state IN ('pending', 'failed');

COMMIT;
