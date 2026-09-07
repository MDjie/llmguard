SET LOCAL lock_timeout = '5s';
ALTER TABLE application_policy_bindings ADD COLUMN IF NOT EXISTS active_snapshot_id varchar(128);
ALTER TABLE application_policy_bindings ADD COLUMN IF NOT EXISTS previous_snapshot_id varchar(128);
ALTER TABLE application_policy_bindings ADD COLUMN IF NOT EXISTS canary_snapshot_id varchar(128);
ALTER TABLE application_policy_bindings ADD COLUMN IF NOT EXISTS shadow_snapshot_id varchar(128);
DO $$ DECLARE column_name text; constraint_name text; BEGIN
  FOREACH column_name IN ARRAY ARRAY['active_snapshot_id','previous_snapshot_id','canary_snapshot_id','shadow_snapshot_id'] LOOP
    constraint_name:='application_binding_'||column_name||'_fk';
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname=constraint_name) THEN
      EXECUTE format('ALTER TABLE application_policy_bindings ADD CONSTRAINT %I FOREIGN KEY(tenant_id,application_id,%I) REFERENCES gateway_runtime_snapshots(tenant_id,application_id,id) ON DELETE RESTRICT NOT VALID',constraint_name,column_name);
    END IF;
  END LOOP;
END $$;
CREATE TABLE IF NOT EXISTS gateway_runtime_publications (
  id uuid PRIMARY KEY, tenant_id varchar(36) NOT NULL, application_id varchar(36) NOT NULL, binding_generation integer NOT NULL,
  manifest jsonb NOT NULL, digest varchar(64) NOT NULL, key_id varchar(128) NOT NULL, signature text NOT NULL,
  dispatch_state varchar(16) NOT NULL DEFAULT 'PENDING' CHECK(dispatch_state IN ('PENDING','ANNOUNCED')),
  audit_event_id uuid REFERENCES security_audit_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), announced_at timestamptz,
  UNIQUE(tenant_id,application_id,binding_generation), UNIQUE(tenant_id,application_id,id),
  FOREIGN KEY(tenant_id,application_id) REFERENCES applications(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS gateway_runtime_publications_pending_idx ON gateway_runtime_publications(created_at) WHERE dispatch_state='PENDING';
CREATE OR REPLACE FUNCTION guard_gateway_publication_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Runtime publication evidence is immutable'; END IF;
  IF (to_jsonb(NEW)-ARRAY['dispatch_state','audit_event_id','announced_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['dispatch_state','audit_event_id','announced_at']) OR
    OLD.dispatch_state='ANNOUNCED' AND NEW IS DISTINCT FROM OLD OR
    NEW.dispatch_state='ANNOUNCED' AND (NEW.audit_event_id IS NULL OR NEW.announced_at IS NULL) THEN
    RAISE EXCEPTION 'Runtime publication manifest is immutable and may be announced once';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS gateway_publication_immutable ON gateway_runtime_publications;
CREATE TRIGGER gateway_publication_immutable BEFORE UPDATE OR DELETE ON gateway_runtime_publications FOR EACH ROW EXECUTE FUNCTION guard_gateway_publication_immutable();
