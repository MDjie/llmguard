SET lock_timeout = '5s';
ALTER TABLE gateway_requests ADD COLUMN IF NOT EXISTS shadow_snapshot_id varchar(128);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gateway_requests_shadow_snapshot_fk') THEN
    ALTER TABLE gateway_requests ADD CONSTRAINT gateway_requests_shadow_snapshot_fk FOREIGN KEY (tenant_id,application_id,shadow_snapshot_id) REFERENCES gateway_runtime_snapshots(tenant_id,application_id,id) NOT VALID;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS gateway_shadow_evaluations (
  id uuid PRIMARY KEY, tenant_id varchar(36) NOT NULL, application_id varchar(36) NOT NULL,
  request_id varchar(128) NOT NULL, step_id varchar(128) NOT NULL, snapshot_id varchar(128) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','RUNNING','SUCCEEDED','FAILED','SKIPPED')),
  action varchar(32), coverage varchar(16), reason_code varchar(128), latency_ms integer,
  evidence jsonb, evidence_hmac varchar(64), audit_event_id uuid REFERENCES security_audit_events(id),
  claimed_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,application_id,request_id,step_id) REFERENCES gateway_steps(tenant_id,application_id,request_id,id),
  FOREIGN KEY (tenant_id,application_id,snapshot_id) REFERENCES gateway_runtime_snapshots(tenant_id,application_id,id),
  UNIQUE (tenant_id,application_id,step_id,snapshot_id)
);
CREATE INDEX IF NOT EXISTS gateway_shadow_pending_idx ON gateway_shadow_evaluations(created_at) WHERE state IN ('PENDING','RUNNING');
CREATE OR REPLACE FUNCTION gateway_shadow_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'shadow evidence cannot be deleted'; END IF;
  IF OLD.state IN ('SUCCEEDED','FAILED','SKIPPED') OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.application_id IS DISTINCT FROM OLD.application_id OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.step_id IS DISTINCT FROM OLD.step_id OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.state = 'RUNNING' AND NEW.state = 'PENDING') THEN RAISE EXCEPTION 'shadow evidence is immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS gateway_shadow_immutable_trigger ON gateway_shadow_evaluations;
CREATE TRIGGER gateway_shadow_immutable_trigger BEFORE UPDATE OR DELETE ON gateway_shadow_evaluations FOR EACH ROW EXECUTE FUNCTION gateway_shadow_immutable();
RESET lock_timeout;
