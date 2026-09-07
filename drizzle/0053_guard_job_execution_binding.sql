SET LOCAL lock_timeout = '5s';
ALTER TABLE guard_jobs ADD COLUMN IF NOT EXISTS execution_binding jsonb;
CREATE OR REPLACE FUNCTION guard_job_frozen_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.execution_binding IS NOT NULL AND
    (NEW.execution_binding, NEW.tenant_id, NEW.application_id, NEW.owner_id, NEW.artifact_id, NEW.bundle_id, NEW.job_type, NEW.request_hash)
    IS DISTINCT FROM
    (OLD.execution_binding, OLD.tenant_id, OLD.application_id, OLD.owner_id, OLD.artifact_id, OLD.bundle_id, OLD.job_type, OLD.request_hash) THEN
    RAISE EXCEPTION 'Guard job source and adapter bindings are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_job_binding_immutable ON guard_jobs;
CREATE TRIGGER guard_job_binding_immutable BEFORE UPDATE ON guard_jobs FOR EACH ROW EXECUTE FUNCTION guard_job_frozen_binding();
