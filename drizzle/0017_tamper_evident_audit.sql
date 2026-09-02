ALTER TABLE security_audit_events
  ADD COLUMN IF NOT EXISTS partition_key varchar(256),
  ADD COLUMN IF NOT EXISTS chain_sequence bigint,
  ADD COLUMN IF NOT EXISTS previous_hash varchar(64),
  ADD COLUMN IF NOT EXISTS event_hash varchar(64),
  ADD COLUMN IF NOT EXISTS hash_key_id varchar(64),
  ADD COLUMN IF NOT EXISTS chain_version integer;

CREATE UNIQUE INDEX IF NOT EXISTS security_audit_events_partition_sequence_uq
  ON security_audit_events (partition_key, chain_sequence)
  WHERE partition_key IS NOT NULL AND chain_sequence IS NOT NULL;

CREATE OR REPLACE FUNCTION guardllm_reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'security_audit_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS security_audit_events_append_only ON security_audit_events;
CREATE TRIGGER security_audit_events_append_only
BEFORE UPDATE OR DELETE ON security_audit_events
FOR EACH ROW EXECUTE FUNCTION guardllm_reject_audit_mutation();

COMMENT ON COLUMN security_audit_events.event_hash IS
  'HMAC-SHA256 over the canonical event, partition, sequence and previous hash';
COMMENT ON COLUMN security_audit_events.chain_version IS
  'NULL denotes a pre-chain legacy event; 1 denotes the HMAC chain format';
