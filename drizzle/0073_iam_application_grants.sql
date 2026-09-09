BEGIN;
CREATE TABLE IF NOT EXISTS user_application_memberships (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id varchar(36) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  attributes jsonb NOT NULL,
  expires_at timestamptz,
  granted_by varchar(128) NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by varchar(128),
  revoked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT user_application_memberships_scope_fk FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id,id),
  CONSTRAINT user_application_memberships_unique UNIQUE (user_id,tenant_id,application_id)
);
CREATE INDEX IF NOT EXISTS user_application_memberships_user_status_idx ON user_application_memberships(user_id,status);
-- Backfill only the previously recorded default application, without expanding access.
INSERT INTO user_application_memberships(user_id,tenant_id,application_id,status,attributes,granted_by)
SELECT m.user_id,m.tenant_id,m.default_application_id,
  CASE WHEN m.status='active' THEN 'active' ELSE 'revoked' END,
  jsonb_build_object('allowedEnvironments',jsonb_build_array(a.environment),'maxDataClass',a.data_class,'userGroupIds','[]'::jsonb),
  'migration:0073'
FROM tenant_memberships m JOIN applications a ON a.id=m.default_application_id AND a.tenant_id=m.tenant_id
ON CONFLICT (user_id,tenant_id,application_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS iam_identity_profiles (
  user_id varchar(36) PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  login_method varchar(20) NOT NULL DEFAULT 'local' CHECK (login_method IN ('local','oidc','emergency')),
  issuer varchar(512),
  subject varchar(255),
  emergency_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT iam_identity_external_unique UNIQUE (issuer,subject),
  CONSTRAINT iam_identity_oidc_required CHECK (login_method <> 'oidc' OR (issuer IS NOT NULL AND subject IS NOT NULL))
);
INSERT INTO iam_identity_profiles(user_id) SELECT id FROM users ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS iam_change_requests (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id),
  application_id varchar(36) NOT NULL,
  target_user_id varchar(36) NOT NULL REFERENCES users(id),
  requester_id varchar(36) NOT NULL REFERENCES users(id),
  kind varchar(32) NOT NULL CHECK (kind IN ('USER_CHANGE','PRIVILEGED_ACTIVATION','EMERGENCY_ACCESS')),
  payload jsonb NOT NULL,
  payload_digest varchar(64) NOT NULL,
  expected_token_version integer NOT NULL,
  requester_token_version integer NOT NULL,
  reason text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  decisions jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT iam_change_scope_fk FOREIGN KEY(tenant_id,application_id) REFERENCES applications(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS iam_change_requests_scope_idx ON iam_change_requests(tenant_id,application_id,status);
CREATE TABLE IF NOT EXISTS iam_oidc_exchanges (
  id varchar(64) PRIMARY KEY,
  browser_hash varchar(64) NOT NULL,
  verifier varchar(128) NOT NULL,
  nonce varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
COMMIT;
