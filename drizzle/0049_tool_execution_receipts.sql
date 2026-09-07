-- Expand existing domain tables; no destructive changes or duplicate permit table.
SET LOCAL lock_timeout = '5s';
ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS executor_configuration_hash varchar(64);
ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS executor_id varchar(128);
ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS execution_request_digest varchar(64);
ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS execution_receipt jsonb;
ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS execution_started_at timestamptz;
ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS execution_deadline_at timestamptz;
CREATE INDEX IF NOT EXISTS tool_invocations_execution_pending_idx
  ON tool_invocations(execution_deadline_at) WHERE status = 'executing';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tool_invocations_scoped_tool_fk') THEN
    ALTER TABLE tool_invocations ADD CONSTRAINT tool_invocations_scoped_tool_fk
      FOREIGN KEY(tenant_id, application_id, tool_id) REFERENCES tool_registry(tenant_id, application_id, id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tool_invocations_scoped_bundle_fk') THEN
    ALTER TABLE tool_invocations ADD CONSTRAINT tool_invocations_scoped_bundle_fk
      FOREIGN KEY(tenant_id, application_id, bundle_id) REFERENCES policy_bundles(tenant_id, application_id, id) NOT VALID;
  END IF;
END $$;

ALTER TABLE tool_invocations DROP CONSTRAINT IF EXISTS tool_invocations_status_ck;
ALTER TABLE tool_invocations ADD CONSTRAINT tool_invocations_status_ck CHECK (
  status IN ('pending_approval','approved','authorized','result_processing','denied','completed','result_blocked','expired','cancelled',
    'executing','execution_unknown','execution_rejected')
) NOT VALID;

CREATE OR REPLACE FUNCTION guard_tool_execution_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.executor_configuration_hash IS NOT NULL THEN
    IF (NEW.tenant_id, NEW.application_id, NEW.principal_id, NEW.agent_run_id, NEW.tool_id, NEW.tool_version,
        NEW.bundle_id, NEW.action, NEW.resource, NEW.parameters_hash, NEW.action_intent_hash,
        NEW.executor_configuration_hash, NEW.executor_id)
       IS DISTINCT FROM
       (OLD.tenant_id, OLD.application_id, OLD.principal_id, OLD.agent_run_id, OLD.tool_id, OLD.tool_version,
        OLD.bundle_id, OLD.action, OLD.resource, OLD.parameters_hash, OLD.action_intent_hash,
        OLD.executor_configuration_hash, OLD.executor_id) THEN
      RAISE EXCEPTION 'Managed invocation bindings are immutable';
    END IF;
    IF OLD.permit_consumed_at IS NOT NULL AND
       (NEW.permit_consumed_at IS DISTINCT FROM OLD.permit_consumed_at OR
        NEW.permit_expires_at IS DISTINCT FROM OLD.permit_expires_at OR
        NEW.approval_decision_id IS DISTINCT FROM OLD.approval_decision_id OR
        NEW.execution_request_digest IS DISTINCT FROM OLD.execution_request_digest OR
        NEW.status IN ('authorized','approved','pending_approval')) THEN
      RAISE EXCEPTION 'Consumed execution permit cannot be restored or modified';
    END IF;
    IF OLD.execution_receipt IS NOT NULL AND NEW.execution_receipt IS DISTINCT FROM OLD.execution_receipt THEN
      RAISE EXCEPTION 'Executor receipt is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tool_execution_immutable ON tool_invocations;
CREATE TRIGGER tool_execution_immutable BEFORE UPDATE ON tool_invocations
FOR EACH ROW EXECUTE FUNCTION guard_tool_execution_immutability();
