ALTER TABLE policy_bundles
  ALTER COLUMN state SET DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS tested_by varchar(100),
  ADD COLUMN IF NOT EXISTS tested_at timestamptz,
  ADD COLUMN IF NOT EXISTS test_evidence_id varchar(36) REFERENCES evaluation_runs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS archived_by varchar(100),
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS lifecycle_version integer NOT NULL DEFAULT 1;

ALTER TABLE policy_bundles DROP CONSTRAINT IF EXISTS policy_bundles_lifecycle_version_check;
ALTER TABLE policy_bundles ADD CONSTRAINT policy_bundles_lifecycle_version_check
  CHECK (lifecycle_version > 0);

CREATE TABLE IF NOT EXISTS policy_bundle_transitions (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id varchar(36) NOT NULL REFERENCES policy_bundles(id) ON DELETE RESTRICT,
  from_state varchar(32),
  to_state varchar(32) NOT NULL,
  action varchar(32) NOT NULL,
  actor_id varchar(100) NOT NULL,
  reason varchar(500),
  evidence_id varchar(100),
  lifecycle_version integer NOT NULL CHECK (lifecycle_version > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bundle_id, lifecycle_version)
);
CREATE INDEX IF NOT EXISTS policy_bundle_transitions_scope_created_idx
  ON policy_bundle_transitions (tenant_id, application_id, created_at);

CREATE OR REPLACE FUNCTION guardllm_reject_policy_bundle_transition_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'policy_bundle_transitions is append-only'; END; $$;
DROP TRIGGER IF EXISTS policy_bundle_transitions_append_only ON policy_bundle_transitions;
CREATE TRIGGER policy_bundle_transitions_append_only BEFORE UPDATE OR DELETE ON policy_bundle_transitions
FOR EACH ROW EXECUTE FUNCTION guardllm_reject_policy_bundle_transition_mutation();
