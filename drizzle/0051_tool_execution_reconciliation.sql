-- Append-only query evidence; an UNKNOWN action is never re-executed by reconciliation.
SET LOCAL lock_timeout = '5s';
ALTER TABLE tool_invocations ADD COLUMN IF NOT EXISTS execution_reconciliations jsonb NOT NULL DEFAULT '[]'::jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_execution_reconciliations_array_ck') THEN
    ALTER TABLE tool_invocations ADD CONSTRAINT tool_execution_reconciliations_array_ck
      CHECK (jsonb_typeof(execution_reconciliations) = 'array' AND jsonb_array_length(execution_reconciliations) <= 32) NOT VALID;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION guard_tool_reconciliation_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_reconciliations IS DISTINCT FROM OLD.execution_reconciliations THEN
    IF jsonb_array_length(NEW.execution_reconciliations) <> jsonb_array_length(OLD.execution_reconciliations) + 1
      OR (NEW.execution_reconciliations - (jsonb_array_length(NEW.execution_reconciliations) - 1)) IS DISTINCT FROM OLD.execution_reconciliations THEN
      RAISE EXCEPTION 'Tool reconciliation evidence is append-only';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tool_reconciliation_append_only ON tool_invocations;
CREATE TRIGGER tool_reconciliation_append_only BEFORE UPDATE ON tool_invocations
  FOR EACH ROW EXECUTE FUNCTION guard_tool_reconciliation_append_only();
