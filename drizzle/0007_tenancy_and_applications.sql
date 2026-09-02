BEGIN;

CREATE TABLE IF NOT EXISTS tenants (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  code varchar(64) NOT NULL UNIQUE,
  name varchar(200) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS applications (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code varchar(64) NOT NULL,
  name varchar(200) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT applications_tenant_code_uq UNIQUE (tenant_id, code),
  CONSTRAINT applications_tenant_id_id_uq UNIQUE (tenant_id, id)
);

INSERT INTO tenants (id, code, name, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'legacy', 'Legacy migrated tenant', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO applications (id, tenant_id, code, name, status)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'default',
  'Default migrated application',
  'active'
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS application_credentials (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  key_id varchar(64) NOT NULL UNIQUE,
  name varchar(128) NOT NULL,
  secret_hash varchar(64) NOT NULL,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by varchar(100) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT application_credentials_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT application_credentials_scope_fk
    FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS application_credentials_scope_idx
  ON application_credentials (tenant_id, application_id);
CREATE INDEX IF NOT EXISTS application_credentials_expires_at_idx
  ON application_credentials (expires_at);

DO $$
DECLARE
  table_name text;
  scope_tables text[] := ARRAY[
    'export_approval_requests',
    'document_scan_tasks',
    'document_scan_findings',
    'secret_envelopes',
    'llm_providers',
    'policy_profiles',
    'policy_rules',
    'keyword_categories',
    'keyword_rules',
    'policy_versions',
    'detection_sessions',
    'detection_records',
    'risk_findings',
    'test_cases',
    'evaluation_runs',
    'detection_dimensions',
    'rule_groups',
    'detection_rules',
    'whitelist_rules',
    'whitelist_rule_policies',
    'policy_dimension_config',
    'agent_traces',
    'policy_judge_configs',
    'judge_model_invocations',
    'evaluation_results',
    'user_policy_states'
  ];
BEGIN
  FOREACH table_name IN ARRAY scope_tables LOOP
    -- Some legacy installations predate optional evaluation tables.
    -- Those tables are created by their owning feature migration.
    CONTINUE WHEN to_regclass(format('%I.%I', 'public', table_name)) IS NULL;

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id varchar(36)', table_name);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS application_id varchar(36)', table_name);
    EXECUTE format(
      'UPDATE %I SET tenant_id = $1 WHERE tenant_id IS NULL',
      table_name
    ) USING '00000000-0000-0000-0000-000000000001';
    EXECUTE format(
      'UPDATE %I SET application_id = $1 WHERE application_id IS NULL',
      table_name
    ) USING '00000000-0000-0000-0000-000000000002';
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', table_name);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN application_id SET NOT NULL', table_name);

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = table_name || '_tenant_fk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT',
        table_name,
        table_name || '_tenant_fk'
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = table_name || '_scope_fk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id) ON DELETE RESTRICT',
        table_name,
        table_name || '_scope_fk'
      );
    END IF;

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id, application_id)',
      table_name || '_scope_idx',
      table_name
    );
  END LOOP;
END $$;

ALTER TABLE llm_providers DROP CONSTRAINT IF EXISTS llm_providers_name_key;
ALTER TABLE policy_profiles DROP CONSTRAINT IF EXISTS policy_profiles_name_key;
ALTER TABLE detection_dimensions DROP CONSTRAINT IF EXISTS detection_dimensions_code_key;

CREATE UNIQUE INDEX IF NOT EXISTS llm_providers_scope_name_uq
  ON llm_providers (tenant_id, application_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS policy_profiles_scope_name_uq
  ON policy_profiles (tenant_id, application_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS detection_dimensions_scope_code_uq
  ON detection_dimensions (tenant_id, application_id, code);

CREATE TABLE IF NOT EXISTS tenant_memberships (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  user_id varchar(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  default_application_id varchar(36) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_memberships_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT tenant_memberships_scope_fk
    FOREIGN KEY (tenant_id, default_application_id) REFERENCES applications(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tenant_memberships_tenant_user_uq UNIQUE (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS tenant_memberships_user_status_idx
  ON tenant_memberships (user_id, status);

INSERT INTO tenant_memberships (tenant_id, user_id, default_application_id, status)
SELECT
  '00000000-0000-0000-0000-000000000001',
  id,
  '00000000-0000-0000-0000-000000000002',
  'active'
FROM users
ON CONFLICT (tenant_id, user_id) DO NOTHING;

COMMIT;
