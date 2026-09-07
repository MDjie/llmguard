SET LOCAL lock_timeout = '5s';
ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS compensates_invocation_id varchar(36);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_compensation_scoped_parent_fk') THEN
    ALTER TABLE tool_invocations ADD CONSTRAINT tool_compensation_scoped_parent_fk
      FOREIGN KEY (tenant_id, application_id, compensates_invocation_id)
      REFERENCES tool_invocations(tenant_id, application_id, id) NOT VALID;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS tool_compensation_one_live_uq ON tool_invocations(tenant_id, application_id, compensates_invocation_id)
  WHERE compensates_invocation_id IS NOT NULL AND status NOT IN ('denied','expired','cancelled');
CREATE OR REPLACE FUNCTION guard_tool_authority_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.action_intent, NEW.supporting_envelope_ids, NEW.data_destinations, NEW.side_effect,
      NEW.context_tainted, NEW.risk_cost, NEW.risk_budget, NEW.compensates_invocation_id)
     IS DISTINCT FROM
     (OLD.action_intent, OLD.supporting_envelope_ids, OLD.data_destinations, OLD.side_effect,
      OLD.context_tainted, OLD.risk_cost, OLD.risk_budget, OLD.compensates_invocation_id) THEN
    RAISE EXCEPTION 'Action authority and compensation bindings are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tool_authority_immutable ON tool_invocations;
CREATE TRIGGER tool_authority_immutable BEFORE UPDATE ON tool_invocations
FOR EACH ROW EXECUTE FUNCTION guard_tool_authority_immutability();
