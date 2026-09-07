SET lock_timeout = '5s';
ALTER TABLE decision_record_outbox ADD COLUMN IF NOT EXISTS failure_code varchar(64);
ALTER TABLE decision_record_outbox ADD COLUMN IF NOT EXISTS failed_at timestamptz;
ALTER TABLE decision_record_outbox ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0);
ALTER TABLE decision_record_outbox DROP CONSTRAINT IF EXISTS decision_record_outbox_state_check;
ALTER TABLE decision_record_outbox ADD CONSTRAINT decision_record_outbox_state_check CHECK (state IN ('PENDING','PROJECTED','FAILED'));
CREATE INDEX IF NOT EXISTS decision_record_failed_scope_idx ON decision_record_outbox(tenant_id,application_id,created_at,id) WHERE state='FAILED';
RESET lock_timeout;
