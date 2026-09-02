CREATE TABLE IF NOT EXISTS audit_evidence_timestamps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_event_id uuid NOT NULL REFERENCES security_audit_events(id) ON DELETE RESTRICT,
  tenant_id varchar(100),
  application_id varchar(100),
  partition_key varchar(256) NOT NULL,
  chain_sequence bigint NOT NULL,
  head_hash varchar(64) NOT NULL CHECK (head_hash ~ '^[a-f0-9]{64}$'),
  provider varchar(128) NOT NULL,
  generated_at timestamptz NOT NULL,
  token text NOT NULL,
  key_fingerprint varchar(64) NOT NULL CHECK (key_fingerprint ~ '^[a-f0-9]{64}$'),
  signature text NOT NULL,
  verification_status varchar(16) NOT NULL CHECK (verification_status = 'VERIFIED'),
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_evidence_timestamps_event_uq UNIQUE (audit_event_id),
  CONSTRAINT audit_evidence_timestamps_partition_sequence_uq
    UNIQUE (partition_key, chain_sequence)
);

CREATE INDEX IF NOT EXISTS audit_evidence_timestamps_generated_idx
  ON audit_evidence_timestamps (generated_at);

COMMENT ON TABLE audit_evidence_timestamps IS
  'Verified enterprise trusted-time tokens anchoring immutable audit chain events';
