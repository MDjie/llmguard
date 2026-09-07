SET lock_timeout = '5s';
CREATE UNIQUE INDEX IF NOT EXISTS policy_bundles_scope_id_uq ON policy_bundles(tenant_id,application_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_requests_snapshot_ref_uq ON gateway_requests(tenant_id,application_id,id,snapshot_id);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_steps_request_ref_uq ON gateway_steps(tenant_id,application_id,request_id,id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='gateway_runtime_snapshots'::regclass AND conname='gateway_snapshots_bundle_scope_fk') THEN
    ALTER TABLE gateway_runtime_snapshots ADD CONSTRAINT gateway_snapshots_bundle_scope_fk
      FOREIGN KEY (tenant_id,application_id,bundle_id) REFERENCES policy_bundles(tenant_id,application_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='gateway_execution_events'::regclass AND conname='gateway_events_request_snapshot_fk') THEN
    ALTER TABLE gateway_execution_events ADD CONSTRAINT gateway_events_request_snapshot_fk
      FOREIGN KEY (tenant_id,application_id,request_id,snapshot_id) REFERENCES gateway_requests(tenant_id,application_id,id,snapshot_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='gateway_execution_events'::regclass AND conname='gateway_events_step_request_fk') THEN
    ALTER TABLE gateway_execution_events ADD CONSTRAINT gateway_events_step_request_fk
      FOREIGN KEY (tenant_id,application_id,request_id,step_id) REFERENCES gateway_steps(tenant_id,application_id,request_id,id) ON DELETE RESTRICT;
  END IF;
END $$;
RESET lock_timeout;
