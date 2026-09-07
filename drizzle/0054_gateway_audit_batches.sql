SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS gateway_audit_batches (
  id uuid PRIMARY KEY, tenant_id varchar(36) NOT NULL, application_id varchar(36) NOT NULL,
  audit_event_id uuid NOT NULL REFERENCES security_audit_events(id) ON DELETE RESTRICT,
  manifest jsonb NOT NULL, digest varchar(64) NOT NULL, key_id varchar(128) NOT NULL, signature text NOT NULL,
  event_count integer NOT NULL CHECK(event_count BETWEEN 1 AND 1000), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,application_id,id), UNIQUE(audit_event_id),
  FOREIGN KEY(tenant_id,application_id) REFERENCES applications(tenant_id,id) ON DELETE RESTRICT
);
ALTER TABLE gateway_execution_events ADD COLUMN IF NOT EXISTS audit_batch_id uuid;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='gateway_event_audit_batch_fk') THEN
    ALTER TABLE gateway_execution_events ADD CONSTRAINT gateway_event_audit_batch_fk
      FOREIGN KEY(tenant_id,application_id,audit_batch_id) REFERENCES gateway_audit_batches(tenant_id,application_id,id) NOT VALID;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS gateway_events_unanchored_idx ON gateway_execution_events(tenant_id,application_id,created_at,id) WHERE audit_batch_id IS NULL;
CREATE INDEX IF NOT EXISTS gateway_events_batch_idx ON gateway_execution_events(audit_batch_id);
CREATE OR REPLACE FUNCTION guard_gateway_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Execution evidence cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - 'audit_batch_id') IS DISTINCT FROM (to_jsonb(OLD) - 'audit_batch_id') OR
    (OLD.audit_batch_id IS NOT NULL AND NEW.audit_batch_id IS DISTINCT FROM OLD.audit_batch_id) THEN
    RAISE EXCEPTION 'Execution evidence is immutable; its audit batch can be bound once';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS gateway_event_append_only ON gateway_execution_events;
CREATE TRIGGER gateway_event_append_only BEFORE UPDATE OR DELETE ON gateway_execution_events FOR EACH ROW EXECUTE FUNCTION guard_gateway_event_append_only();
CREATE OR REPLACE FUNCTION guard_gateway_batch_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Gateway audit batch is immutable'; END $$;
DROP TRIGGER IF EXISTS gateway_batch_immutable ON gateway_audit_batches;
CREATE TRIGGER gateway_batch_immutable BEFORE UPDATE OR DELETE ON gateway_audit_batches FOR EACH ROW EXECUTE FUNCTION guard_gateway_batch_immutable();
