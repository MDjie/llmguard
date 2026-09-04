BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS dictionary_releases_one_active_uq
  ON dictionary_releases (tenant_id, application_id, dictionary_id)
  WHERE state = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS response_templates_one_active_selector_uq
  ON response_templates (
    tenant_id,
    application_id,
    risk_category,
    action,
    locale,
    industry,
    jurisdiction,
    business_line
  )
  WHERE approval_status = 'approved' AND enabled;

CREATE TABLE IF NOT EXISTS content_access_requests (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type varchar(32) NOT NULL,
  resource_id varchar(128) NOT NULL,
  source_digest varchar(64) NOT NULL,
  requester_id varchar(100) NOT NULL,
  purpose varchar(40) NOT NULL,
  reason varchar(500) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  reviewed_by varchar(100),
  reviewed_at timestamptz,
  decision_reason varchar(500),
  expires_at timestamptz,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_access_requests_resource_ck CHECK (
    resource_type IN ('INCIDENT_EVIDENCE')
  ),
  CONSTRAINT content_access_requests_purpose_ck CHECK (
    purpose IN ('INCIDENT_INVESTIGATION', 'REGULATORY_REVIEW', 'FALSE_POSITIVE_APPEAL')
  ),
  CONSTRAINT content_access_requests_digest_ck CHECK (
    source_digest ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT content_access_requests_status_ck CHECK (
    status IN ('pending', 'approved', 'rejected', 'expired')
  ),
  CONSTRAINT content_access_requests_review_ck CHECK (
    (status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR
    (status IN ('approved', 'rejected', 'expired') AND reviewed_by IS NOT NULL AND
      reviewed_at IS NOT NULL AND reviewed_by <> requester_id)
  ),
  CONSTRAINT content_access_requests_expiry_ck CHECK (
    status <> 'approved' OR (expires_at IS NOT NULL AND expires_at > reviewed_at)
  ),
  CONSTRAINT content_access_requests_use_ck CHECK (
    used_at IS NULL OR (
      status = 'approved' AND reviewed_at IS NOT NULL AND expires_at IS NOT NULL AND
      used_at >= reviewed_at AND used_at <= expires_at
    )
  )
);

CREATE INDEX IF NOT EXISTS content_access_requests_scope_status_idx
  ON content_access_requests (tenant_id, application_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS content_access_requests_resource_idx
  ON content_access_requests (tenant_id, application_id, resource_type, resource_id);
CREATE UNIQUE INDEX IF NOT EXISTS content_access_requests_pending_uq
  ON content_access_requests (tenant_id, application_id, resource_type, resource_id, requester_id)
  WHERE status = 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'content_access_requests_application_scope_fk'
       AND conrelid = to_regclass('content_access_requests')
  ) THEN
    ALTER TABLE content_access_requests
      ADD CONSTRAINT content_access_requests_application_scope_fk
      FOREIGN KEY (tenant_id, application_id)
      REFERENCES applications(tenant_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION guard_content_access_request_identity_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'content access requests are append-preserved';
  END IF;
  IF ROW(
    OLD.tenant_id, OLD.application_id, OLD.resource_type, OLD.resource_id,
    OLD.source_digest, OLD.requester_id, OLD.purpose, OLD.reason, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.tenant_id, NEW.application_id, NEW.resource_type, NEW.resource_id,
    NEW.source_digest, NEW.requester_id, NEW.purpose, NEW.reason, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'content access request identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'content_access_requests_identity_immutable'
  ) THEN
    CREATE TRIGGER content_access_requests_identity_immutable
      BEFORE UPDATE OR DELETE ON content_access_requests
      FOR EACH ROW EXECUTE FUNCTION guard_content_access_request_identity_immutable();
  END IF;
END $$;

COMMIT;
