CREATE TABLE IF NOT EXISTS security_scan_assets (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type varchar(32) NOT NULL CHECK (
    target_type IN ('REGISTERED_HOST', 'REGISTERED_WEB_APP', 'MODEL_ARTIFACT')
  ),
  external_inventory_id varchar(256) NOT NULL,
  version varchar(256) NOT NULL,
  sha256 varchar(71) CHECK (sha256 IS NULL OR sha256 ~ '^sha256:[a-f0-9]{64}$'),
  status varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_by varchar(100) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT security_scan_assets_scope_external_version_uq UNIQUE (
    tenant_id, application_id, target_type, external_inventory_id, version
  ),
  CONSTRAINT security_scan_asset_model_digest_check CHECK (
    target_type <> 'MODEL_ARTIFACT' OR sha256 IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS security_scan_assets_scope_status_idx
  ON security_scan_assets (tenant_id, application_id, status);

CREATE TABLE IF NOT EXISTS security_scan_tasks (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES security_scan_assets(id) ON DELETE RESTRICT,
  scanner_id varchar(128) NOT NULL,
  scan_kind varchar(32) NOT NULL CHECK (scan_kind IN ('HOST', 'WEB', 'MODEL_SUPPLY_CHAIN')),
  target_type varchar(32) NOT NULL CHECK (
    target_type IN ('REGISTERED_HOST', 'REGISTERED_WEB_APP', 'MODEL_ARTIFACT')
  ),
  target_inventory_id varchar(256) NOT NULL,
  target_version varchar(256) NOT NULL,
  target_sha256 varchar(71) CHECK (
    target_sha256 IS NULL OR target_sha256 ~ '^sha256:[a-f0-9]{64}$'
  ),
  scanner_definition_digest varchar(71) NOT NULL CHECK (
    scanner_definition_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  submitted_by varchar(100) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'QUEUED' CHECK (
    status IN ('QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'CANCELED')
  ),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  failure_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  result_digest varchar(71) CHECK (
    result_digest IS NULL OR result_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  heartbeat_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT security_scan_tasks_scope_idempotency_uq
    UNIQUE (tenant_id, application_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS security_scan_tasks_scope_status_idx
  ON security_scan_tasks (tenant_id, application_id, status);
CREATE INDEX IF NOT EXISTS security_scan_tasks_status_created_idx
  ON security_scan_tasks (status, created_at);

CREATE TABLE IF NOT EXISTS security_scan_attempts (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES security_scan_tasks(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0),
  status varchar(24) NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED')),
  scanner_id varchar(128) NOT NULL,
  scanner_version varchar(256),
  scanner_digest varchar(71),
  raw_output_digest varchar(71),
  error_code varchar(128),
  error_message varchar(500),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT security_scan_attempts_scope_task_attempt_uq
    UNIQUE (tenant_id, application_id, task_id, attempt)
);

CREATE INDEX IF NOT EXISTS security_scan_attempts_task_idx
  ON security_scan_attempts (task_id);

CREATE TABLE IF NOT EXISTS security_scan_findings (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES security_scan_tasks(id) ON DELETE CASCADE,
  fingerprint varchar(64) NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  rule_id varchar(256) NOT NULL,
  category varchar(128) NOT NULL,
  severity varchar(16) NOT NULL CHECK (
    severity IN ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')
  ),
  title varchar(500) NOT NULL,
  evidence_digest varchar(71) NOT NULL CHECK (evidence_digest ~ '^sha256:[a-f0-9]{64}$'),
  remediation text,
  disposition varchar(32) NOT NULL DEFAULT 'UNREVIEWED' CHECK (
    disposition IN (
      'UNREVIEWED', 'CONFIRMED', 'FALSE_POSITIVE', 'DISPUTED',
      'ARBITRATED_CONFIRMED', 'ARBITRATED_FALSE_POSITIVE'
    )
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT security_scan_findings_scope_task_fingerprint_uq
    UNIQUE (tenant_id, application_id, task_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS security_scan_findings_task_idx
  ON security_scan_findings (task_id);
CREATE INDEX IF NOT EXISTS security_scan_findings_scope_severity_idx
  ON security_scan_findings (tenant_id, application_id, severity);

CREATE TABLE IF NOT EXISTS security_scan_finding_reviews (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES security_scan_findings(id) ON DELETE CASCADE,
  reviewer_id varchar(100) NOT NULL,
  disposition varchar(32) NOT NULL CHECK (
    disposition IN (
      'CONFIRMED', 'FALSE_POSITIVE', 'DISPUTED',
      'ARBITRATED_CONFIRMED', 'ARBITRATED_FALSE_POSITIVE'
    )
  ),
  reason varchar(1000) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT security_scan_reviews_scope_finding_reviewer_uq
    UNIQUE (tenant_id, application_id, finding_id, reviewer_id)
);

CREATE INDEX IF NOT EXISTS security_scan_reviews_finding_idx
  ON security_scan_finding_reviews (finding_id);

CREATE OR REPLACE FUNCTION reject_security_scan_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'security scan evidence is immutable';
END;
$$;

DROP TRIGGER IF EXISTS security_scan_attempts_immutable ON security_scan_attempts;
CREATE TRIGGER security_scan_attempts_immutable
  BEFORE UPDATE OR DELETE ON security_scan_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_security_scan_evidence_mutation();

DROP TRIGGER IF EXISTS security_scan_findings_immutable_content ON security_scan_findings;
CREATE TRIGGER security_scan_findings_immutable_content
  BEFORE UPDATE OF task_id, fingerprint, rule_id, category, severity, title,
    evidence_digest, remediation, created_at ON security_scan_findings
  FOR EACH ROW EXECUTE FUNCTION reject_security_scan_evidence_mutation();

DROP TRIGGER IF EXISTS security_scan_reviews_immutable ON security_scan_finding_reviews;
CREATE TRIGGER security_scan_reviews_immutable
  BEFORE UPDATE OR DELETE ON security_scan_finding_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_security_scan_evidence_mutation();
