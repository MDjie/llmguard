CREATE TABLE IF NOT EXISTS guard_session_risk_states (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id varchar(128) NOT NULL,
  tail_envelope jsonb NOT NULL,
  turn_count integer NOT NULL DEFAULT 1 CHECK (turn_count > 0),
  state_version integer NOT NULL DEFAULT 1 CHECK (state_version > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, application_id, session_id)
);

CREATE INDEX IF NOT EXISTS guard_session_risk_states_expires_idx
  ON guard_session_risk_states (expires_at);

ALTER TABLE guard_session_risk_states DROP CONSTRAINT IF EXISTS guard_session_risk_states_envelope_check;
ALTER TABLE guard_session_risk_states ADD CONSTRAINT guard_session_risk_states_envelope_check CHECK (
  jsonb_typeof(tail_envelope) = 'object'
  AND tail_envelope->>'algorithm' = 'AES-256-GCM'
  AND length(tail_envelope->>'keyId') > 0
  AND length(tail_envelope->>'iv') > 0
  AND length(tail_envelope->>'ciphertext') > 0
  AND length(tail_envelope->>'authTag') > 0
);
