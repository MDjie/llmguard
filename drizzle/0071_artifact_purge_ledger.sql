-- Keep reservations until every exact object version has been physically removed.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS purged_at timestamptz;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS hold_until timestamptz;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS upload_expires_at timestamptz;
CREATE TABLE IF NOT EXISTS artifact_purge_ledger (
  artifact_id varchar(36) PRIMARY KEY,
  tenant_id varchar(36) NOT NULL, application_id varchar(36) NOT NULL,
  state varchar(20) NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','DELETING','PURGED')),
  object_prefix varchar(800) NOT NULL,
  not_before timestamptz NOT NULL, retry_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid, lease_until timestamptz,
  versions jsonb NOT NULL DEFAULT '[]', attempt integer NOT NULL DEFAULT 0,
  error_code varchar(128), created_at timestamptz NOT NULL DEFAULT now(), purged_at timestamptz,
  CONSTRAINT artifact_purge_scope_fk FOREIGN KEY (tenant_id,application_id,artifact_id)
    REFERENCES artifacts(tenant_id,application_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS artifact_purge_pending_idx ON artifact_purge_ledger(state,retry_at,not_before);
