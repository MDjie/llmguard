SET LOCAL lock_timeout = '5s';
ALTER TABLE gateway_requests ADD COLUMN IF NOT EXISTS content_hold_until timestamptz;
ALTER TABLE gateway_requests ADD COLUMN IF NOT EXISTS content_hold_reason_hmac varchar(64);
ALTER TABLE gateway_requests ADD COLUMN IF NOT EXISTS retention_version integer NOT NULL DEFAULT 0;
ALTER TABLE gateway_requests ADD COLUMN IF NOT EXISTS content_purged_at timestamptz;
ALTER TABLE gateway_requests ADD COLUMN IF NOT EXISTS deletion_proof_id uuid REFERENCES data_deletion_proofs(proof_id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS gateway_requests_content_expiry_idx ON gateway_requests(expires_at,tenant_id,application_id)
  WHERE content_purged_at IS NULL AND session_finalized;
CREATE OR REPLACE FUNCTION guard_gateway_content_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.content_purged_at IS NOT NULL AND (
    NEW.content_purged_at IS DISTINCT FROM OLD.content_purged_at OR NEW.deletion_proof_id IS DISTINCT FROM OLD.deletion_proof_id OR
    NEW.session_snapshot IS NOT NULL OR NEW.content_hold_until IS DISTINCT FROM OLD.content_hold_until) THEN
    RAISE EXCEPTION 'Purged gateway content cannot be restored or retrospectively held';
  END IF;
  IF NEW.content_purged_at IS NOT NULL AND (NEW.session_snapshot IS NOT NULL OR NEW.deletion_proof_id IS NULL OR NOT NEW.session_finalized) THEN
    RAISE EXCEPTION 'Gateway content deletion requires a proof and finalized session';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS gateway_request_content_tombstone ON gateway_requests;
CREATE TRIGGER gateway_request_content_tombstone BEFORE UPDATE ON gateway_requests FOR EACH ROW EXECUTE FUNCTION guard_gateway_content_tombstone();
CREATE OR REPLACE FUNCTION guard_gateway_step_content_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decision_envelope IS NOT NULL AND EXISTS(SELECT 1 FROM gateway_requests r WHERE
    r.tenant_id=NEW.tenant_id AND r.application_id=NEW.application_id AND r.id=NEW.request_id AND r.content_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'A purged request cannot receive restored step content';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS gateway_step_content_tombstone ON gateway_steps;
CREATE TRIGGER gateway_step_content_tombstone BEFORE INSERT OR UPDATE ON gateway_steps FOR EACH ROW EXECUTE FUNCTION guard_gateway_step_content_tombstone();
