BEGIN;

CREATE TABLE IF NOT EXISTS tool_registry (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  name varchar(200) NOT NULL,
  version varchar(64) NOT NULL,
  kind varchar(16) NOT NULL,
  endpoint varchar(1000),
  server_identity varchar(500),
  allowed_roles jsonb DEFAULT '[]'::jsonb,
  allowed_actions jsonb DEFAULT '[]'::jsonb,
  resource_patterns jsonb DEFAULT '[]'::jsonb,
  parameter_policy jsonb DEFAULT '{}'::jsonb,
  high_risk boolean NOT NULL DEFAULT false,
  approval_required boolean NOT NULL DEFAULT false,
  result_guard_required boolean NOT NULL DEFAULT true,
  status varchar(20) NOT NULL DEFAULT 'active',
  created_by varchar(100) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tool_registry_scope_fk FOREIGN KEY (tenant_id, application_id)
    REFERENCES applications(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tool_registry_kind_ck CHECK (kind IN ('HTTP','MCP')),
  CONSTRAINT tool_registry_status_ck CHECK (status IN ('active','disabled','revoked')),
  CONSTRAINT tool_registry_scope_name_version_uq UNIQUE (tenant_id, application_id, name, version),
  CONSTRAINT tool_registry_scope_id_uq UNIQUE (tenant_id, application_id, id)
);
CREATE INDEX IF NOT EXISTS tool_registry_scope_status_idx ON tool_registry (tenant_id, application_id, status);

CREATE TABLE IF NOT EXISTS tool_invocations (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  request_id varchar(128) NOT NULL,
  trace_id varchar(128) NOT NULL,
  principal_id varchar(100) NOT NULL,
  tool_id varchar(36) NOT NULL,
  bundle_id varchar(36) NOT NULL,
  action varchar(128) NOT NULL,
  resource varchar(1000) NOT NULL,
  parameters_hash varchar(64) NOT NULL,
  context_tainted boolean NOT NULL DEFAULT false,
  status varchar(32) NOT NULL,
  permit_expires_at timestamptz,
  result_decision jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT tool_invocations_tool_scope_fk FOREIGN KEY (tenant_id, application_id, tool_id)
    REFERENCES tool_registry(tenant_id, application_id, id) ON DELETE RESTRICT,
  CONSTRAINT tool_invocations_bundle_scope_fk FOREIGN KEY (tenant_id, application_id, bundle_id)
    REFERENCES policy_bundles(tenant_id, application_id, id) ON DELETE RESTRICT,
  CONSTRAINT tool_invocations_status_ck CHECK (status IN ('pending_approval','approved','authorized','result_processing','denied','completed','result_blocked','expired','cancelled')),
  CONSTRAINT tool_invocations_scope_request_uq UNIQUE (tenant_id, application_id, request_id),
  CONSTRAINT tool_invocations_scope_id_uq UNIQUE (tenant_id, application_id, id)
);
CREATE INDEX IF NOT EXISTS tool_invocations_scope_status_idx ON tool_invocations (tenant_id, application_id, status);

CREATE TABLE IF NOT EXISTS tool_approvals (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  invocation_id varchar(36) NOT NULL,
  requester_id varchar(100) NOT NULL,
  approver_id varchar(100),
  status varchar(20) NOT NULL DEFAULT 'pending',
  reason varchar(500),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT tool_approvals_invocation_scope_fk FOREIGN KEY (tenant_id, application_id, invocation_id)
    REFERENCES tool_invocations(tenant_id, application_id, id) ON DELETE CASCADE,
  CONSTRAINT tool_approvals_status_ck CHECK (status IN ('pending','approved','rejected')),
  CONSTRAINT tool_approvals_approver_ck CHECK (approver_id IS NULL OR approver_id <> requester_id),
  CONSTRAINT tool_approvals_scope_invocation_uq UNIQUE (tenant_id, application_id, invocation_id)
);
CREATE INDEX IF NOT EXISTS tool_approvals_scope_status_idx ON tool_approvals (tenant_id, application_id, status);

COMMIT;
