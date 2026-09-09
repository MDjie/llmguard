BEGIN;
ALTER TABLE llm_providers ADD COLUMN IF NOT EXISTS governance_version integer NOT NULL DEFAULT 1;
ALTER TABLE llm_providers ADD COLUMN IF NOT EXISTS proposed_by varchar(100);
CREATE TABLE IF NOT EXISTS provider_approval_requests (
 id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
 tenant_id varchar(36) NOT NULL, application_id varchar(36) NOT NULL,
 provider_id varchar(36) NOT NULL REFERENCES llm_providers(id) ON DELETE RESTRICT,
 requester_id varchar(36) NOT NULL REFERENCES users(id),
 reviewer_id varchar(36) REFERENCES users(id),
 payload jsonb NOT NULL, payload_digest varchar(64) NOT NULL,
 expected_version integer NOT NULL, reason text NOT NULL,
 status varchar(20) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired')),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz,
 FOREIGN KEY(tenant_id,application_id) REFERENCES applications(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS provider_approval_scope_idx ON provider_approval_requests(tenant_id,application_id,status);
COMMIT;
