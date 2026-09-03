CREATE TABLE IF NOT EXISTS guard_quota_counters (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_bundle_id varchar(36) NOT NULL,
  scope_type varchar(24) NOT NULL CHECK (
    scope_type IN ('TENANT', 'APPLICATION', 'USER', 'USER_GROUP', 'CREDENTIAL', 'MODEL', 'API')
  ),
  scope_id varchar(256) NOT NULL,
  metric varchar(32) NOT NULL CHECK (
    metric IN ('REQUESTS', 'INPUT_TOKENS', 'OUTPUT_TOKENS', 'CONCURRENCY', 'COST_UNITS')
  ),
  "window" varchar(16) NOT NULL CHECK ("window" IN ('MINUTE', 'DAY', 'MONTH', 'INSTANT')),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  used bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  limit_value bigint NOT NULL CHECK (limit_value > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guard_quota_counters_identity_window_uq UNIQUE (
    tenant_id, application_id, policy_bundle_id, scope_type, scope_id,
    metric, "window", window_start
  ),
  CONSTRAINT guard_quota_counter_window_check CHECK (window_end > window_start)
);

CREATE INDEX IF NOT EXISTS guard_quota_counters_expiry_idx
  ON guard_quota_counters (window_end);

CREATE TABLE IF NOT EXISTS guard_quota_charges (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  counter_id uuid NOT NULL REFERENCES guard_quota_counters(id) ON DELETE RESTRICT,
  request_id varchar(128) NOT NULL,
  amount bigint NOT NULL CHECK (amount >= 0),
  release_required boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guard_quota_charges_scope_counter_request_uq
    UNIQUE (tenant_id, application_id, counter_id, request_id),
  CONSTRAINT guard_quota_charge_lease_check CHECK (
    (release_required AND expires_at IS NOT NULL) OR
    (NOT release_required AND expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS guard_quota_charges_expiry_idx
  ON guard_quota_charges (expires_at, released_at);
CREATE INDEX IF NOT EXISTS guard_quota_charges_request_idx
  ON guard_quota_charges (tenant_id, application_id, request_id);
