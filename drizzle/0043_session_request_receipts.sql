BEGIN;
CREATE TABLE IF NOT EXISTS guard_session_request_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(36) NOT NULL, application_id varchar(36) NOT NULL,
  session_id varchar(128) NOT NULL, request_id varchar(128) NOT NULL, direction varchar(32) NOT NULL,
  request_hmac varchar(64) NOT NULL CHECK (request_hmac ~ '^[a-f0-9]{64}$'),
  key_id varchar(128) NOT NULL, decision_envelopes jsonb NOT NULL CHECK (jsonb_typeof(decision_envelopes)='array'),
  event_id uuid NOT NULL, state_version integer NOT NULL CHECK (state_version>0), sequence_number bigint NOT NULL CHECK (sequence_number>0),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guard_session_receipts_application_scope_fk FOREIGN KEY(tenant_id,application_id)
    REFERENCES applications(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT guard_session_receipts_request_uq UNIQUE(tenant_id,application_id,session_id,request_id,direction)
);
CREATE INDEX IF NOT EXISTS guard_session_receipts_expiry_idx ON guard_session_request_receipts(expires_at);
COMMENT ON TABLE guard_session_request_receipts IS 'Encrypted decision receipts; expiry rejects replay. Purge encrypted payloads but retain minimal idempotency tombstones until session-ID retirement.';
COMMIT;
