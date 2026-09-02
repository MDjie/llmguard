BEGIN;

CREATE TABLE IF NOT EXISTS evaluation_results (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  run_id varchar(36) NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  test_case_id varchar(36) NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  expected_action varchar(20),
  actual_action varchar(20),
  actual_score integer,
  is_correct boolean NOT NULL,
  findings jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evaluation_results_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT evaluation_results_scope_fk
    FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS evaluation_results_scope_idx ON evaluation_results (tenant_id, application_id);
CREATE INDEX IF NOT EXISTS evaluation_results_run_id_idx ON evaluation_results (run_id);
CREATE INDEX IF NOT EXISTS evaluation_results_test_case_id_idx ON evaluation_results (test_case_id);

CREATE UNIQUE INDEX IF NOT EXISTS policy_profiles_scope_id_uq
  ON policy_profiles (tenant_id, application_id, id);

CREATE TABLE IF NOT EXISTS policy_bundles (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  policy_id varchar(36) NOT NULL,
  version integer NOT NULL,
  state varchar(32) NOT NULL DEFAULT 'pending_approval',
  canonical_json jsonb NOT NULL,
  content_hash varchar(64) NOT NULL,
  signature text NOT NULL,
  signature_algorithm varchar(32) NOT NULL DEFAULT 'Ed25519',
  signing_key_id varchar(128) NOT NULL,
  created_by varchar(100) NOT NULL,
  approved_by varchar(100),
  approved_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT policy_bundles_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT policy_bundles_scope_fk
    FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT policy_bundles_policy_scope_fk
    FOREIGN KEY (tenant_id, application_id, policy_id)
    REFERENCES policy_profiles(tenant_id, application_id, id) ON DELETE RESTRICT,
  CONSTRAINT policy_bundles_scope_policy_version_uq
    UNIQUE (tenant_id, application_id, policy_id, version),
  CONSTRAINT policy_bundles_scope_id_uq
    UNIQUE (tenant_id, application_id, id)
);

CREATE INDEX IF NOT EXISTS policy_bundles_scope_state_idx
  ON policy_bundles (tenant_id, application_id, state);

CREATE TABLE IF NOT EXISTS application_policy_bindings (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  active_bundle_id varchar(36),
  shadow_bundle_id varchar(36),
  canary_bundle_id varchar(36),
  previous_bundle_id varchar(36),
  canary_percent integer NOT NULL DEFAULT 0 CHECK (canary_percent BETWEEN 0 AND 100),
  generation integer NOT NULL DEFAULT 0,
  updated_by varchar(100) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT application_policy_bindings_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT application_policy_bindings_scope_fk
    FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT application_policy_bindings_active_fk
    FOREIGN KEY (tenant_id, application_id, active_bundle_id)
    REFERENCES policy_bundles(tenant_id, application_id, id) ON DELETE RESTRICT,
  CONSTRAINT application_policy_bindings_shadow_fk
    FOREIGN KEY (tenant_id, application_id, shadow_bundle_id)
    REFERENCES policy_bundles(tenant_id, application_id, id) ON DELETE RESTRICT,
  CONSTRAINT application_policy_bindings_canary_fk
    FOREIGN KEY (tenant_id, application_id, canary_bundle_id)
    REFERENCES policy_bundles(tenant_id, application_id, id) ON DELETE RESTRICT,
  CONSTRAINT application_policy_bindings_previous_fk
    FOREIGN KEY (tenant_id, application_id, previous_bundle_id)
    REFERENCES policy_bundles(tenant_id, application_id, id) ON DELETE RESTRICT,
  CONSTRAINT application_policy_bindings_scope_uq
    UNIQUE (tenant_id, application_id)
);

COMMIT;
