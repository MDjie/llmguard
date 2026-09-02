BEGIN;

ALTER TABLE evaluation_runs ADD COLUMN IF NOT EXISTS bundle_id varchar(36);
ALTER TABLE evaluation_runs ADD COLUMN IF NOT EXISTS idempotency_key varchar(128);
ALTER TABLE evaluation_runs ADD COLUMN IF NOT EXISTS dataset_hash varchar(64);
ALTER TABLE evaluation_runs ADD COLUMN IF NOT EXISTS request_hash varchar(64);
ALTER TABLE evaluation_runs ADD COLUMN IF NOT EXISTS metrics jsonb DEFAULT '{}'::jsonb;
ALTER TABLE evaluation_runs ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0;
ALTER TABLE evaluation_runs ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3;
ALTER TABLE evaluation_runs ADD COLUMN IF NOT EXISTS failure_history jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE evaluation_runs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS decision_id varchar(128);
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS latency_ms integer;
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS decision jsonb DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS test_cases_scope_id_uq
  ON test_cases (tenant_id, application_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS evaluation_runs_scope_id_uq
  ON evaluation_runs (tenant_id, application_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS evaluation_runs_scope_idempotency_uq
  ON evaluation_runs (tenant_id, application_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS evaluation_runs_scope_status_idx
  ON evaluation_runs (tenant_id, application_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS evaluation_results_scope_run_case_uq
  ON evaluation_results (tenant_id, application_id, run_id, test_case_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evaluation_runs_bundle_fk') THEN
    ALTER TABLE evaluation_runs ADD CONSTRAINT evaluation_runs_bundle_fk
      FOREIGN KEY (tenant_id, application_id, bundle_id)
      REFERENCES policy_bundles(tenant_id, application_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evaluation_results_run_scope_fk') THEN
    ALTER TABLE evaluation_results ADD CONSTRAINT evaluation_results_run_scope_fk
      FOREIGN KEY (tenant_id, application_id, run_id)
      REFERENCES evaluation_runs(tenant_id, application_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evaluation_results_case_scope_fk') THEN
    ALTER TABLE evaluation_results ADD CONSTRAINT evaluation_results_case_scope_fk
      FOREIGN KEY (tenant_id, application_id, test_case_id)
      REFERENCES test_cases(tenant_id, application_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_bundles_state_ck') THEN
    ALTER TABLE policy_bundles ADD CONSTRAINT policy_bundles_state_ck CHECK (
      state IN ('pending_approval', 'approved', 'shadow', 'canary', 'active', 'retired', 'revoked')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_bundles_approver_ck') THEN
    ALTER TABLE policy_bundles ADD CONSTRAINT policy_bundles_approver_ck CHECK (
      approved_by IS NULL OR approved_by <> created_by
    );
  END IF;
END $$;

ALTER TABLE evaluation_runs VALIDATE CONSTRAINT evaluation_runs_bundle_fk;
ALTER TABLE evaluation_results VALIDATE CONSTRAINT evaluation_results_run_scope_fk;
ALTER TABLE evaluation_results VALIDATE CONSTRAINT evaluation_results_case_scope_fk;

COMMIT;
