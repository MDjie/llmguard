ALTER TABLE detection_sessions
  ALTER COLUMN user_prompt DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS user_prompt_hash varchar(64),
  ADD COLUMN IF NOT EXISTS mock_model_output_hash varchar(64),
  ADD COLUMN IF NOT EXISTS final_response_hash varchar(64);

ALTER TABLE detection_records
  ALTER COLUMN raw_text DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS raw_text_hash varchar(64);

CREATE INDEX IF NOT EXISTS detection_sessions_user_prompt_hash_idx
  ON detection_sessions (user_prompt_hash);

CREATE INDEX IF NOT EXISTS detection_records_raw_text_hash_idx
  ON detection_records (raw_text_hash);

-- Rollback requires confirming that every row has restored source content first:
-- ALTER TABLE detection_records DROP COLUMN raw_text_hash;
-- ALTER TABLE detection_sessions
--   DROP COLUMN user_prompt_hash,
--   DROP COLUMN mock_model_output_hash,
--   DROP COLUMN final_response_hash;
-- Do not restore NOT NULL until a controlled backfill has completed.
