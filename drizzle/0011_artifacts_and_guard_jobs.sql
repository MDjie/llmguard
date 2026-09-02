BEGIN;

CREATE TABLE IF NOT EXISTS artifacts (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  owner_id varchar(100) NOT NULL,
  kind varchar(24) NOT NULL,
  file_name varchar(500) NOT NULL,
  declared_media_type varchar(200) NOT NULL,
  detected_media_type varchar(200),
  declared_size bigint NOT NULL,
  verified_size bigint,
  declared_sha256 varchar(64) NOT NULL,
  verified_sha256 varchar(64),
  object_prefix varchar(800) NOT NULL,
  state varchar(24) NOT NULL DEFAULT 'uploading',
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  part_size integer NOT NULL,
  part_count integer NOT NULL,
  failure_code varchar(100),
  metadata jsonb DEFAULT '{}'::jsonb,
  content_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  verified_at timestamptz,
  CONSTRAINT artifacts_scope_fk FOREIGN KEY (tenant_id, application_id)
    REFERENCES applications(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT artifacts_kind_ck CHECK (kind IN ('TEXT','IMAGE','AUDIO','VIDEO','DOCUMENT','TOOL_RESULT','RAG_CHUNK')),
  CONSTRAINT artifacts_state_ck CHECK (state IN ('uploading','verifying','verification_running','accepted','quarantined','deleted','failed')),
  CONSTRAINT artifacts_size_ck CHECK (declared_size > 0 AND declared_size <= 3221225472),
  CONSTRAINT artifacts_part_ck CHECK (part_size >= 5242880 AND part_count BETWEEN 1 AND 10000),
  CONSTRAINT artifacts_scope_idempotency_uq UNIQUE (tenant_id, application_id, idempotency_key),
  CONSTRAINT artifacts_scope_id_uq UNIQUE (tenant_id, application_id, id)
);
CREATE INDEX IF NOT EXISTS artifacts_scope_state_idx ON artifacts (tenant_id, application_id, state);
CREATE INDEX IF NOT EXISTS artifacts_expires_at_idx ON artifacts (content_expires_at);

CREATE TABLE IF NOT EXISTS artifact_parts (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  artifact_id varchar(36) NOT NULL,
  part_number integer NOT NULL,
  size_bytes integer NOT NULL,
  sha256 varchar(64) NOT NULL,
  etag varchar(200),
  object_key varchar(900) NOT NULL,
  state varchar(20) NOT NULL DEFAULT 'declared',
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifact_parts_artifact_scope_fk FOREIGN KEY (tenant_id, application_id, artifact_id)
    REFERENCES artifacts(tenant_id, application_id, id) ON DELETE CASCADE,
  CONSTRAINT artifact_parts_number_ck CHECK (part_number BETWEEN 1 AND 10000),
  CONSTRAINT artifact_parts_size_ck CHECK (size_bytes > 0),
  CONSTRAINT artifact_parts_state_ck CHECK (state IN ('declared','verified','failed','deleted')),
  CONSTRAINT artifact_parts_scope_number_uq UNIQUE (tenant_id, application_id, artifact_id, part_number)
);
CREATE INDEX IF NOT EXISTS artifact_parts_artifact_idx ON artifact_parts (artifact_id);

CREATE TABLE IF NOT EXISTS guard_jobs (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  owner_id varchar(100) NOT NULL,
  artifact_id varchar(36) NOT NULL,
  bundle_id varchar(36) NOT NULL,
  job_type varchar(32) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'pending',
  stage varchar(64) NOT NULL DEFAULT 'queued',
  progress integer NOT NULL DEFAULT 0,
  idempotency_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  failure_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  result jsonb DEFAULT '{}'::jsonb,
  callback_url varchar(1000),
  callback_secret_ref varchar(100),
  callback_state varchar(24) DEFAULT 'not_requested',
  heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  CONSTRAINT guard_jobs_artifact_scope_fk FOREIGN KEY (tenant_id, application_id, artifact_id)
    REFERENCES artifacts(tenant_id, application_id, id) ON DELETE RESTRICT,
  CONSTRAINT guard_jobs_bundle_scope_fk FOREIGN KEY (tenant_id, application_id, bundle_id)
    REFERENCES policy_bundles(tenant_id, application_id, id) ON DELETE RESTRICT,
  CONSTRAINT guard_jobs_status_ck CHECK (status IN ('pending','running','retrying','completed','failed','cancelled')),
  CONSTRAINT guard_jobs_progress_ck CHECK (progress BETWEEN 0 AND 100),
  CONSTRAINT guard_jobs_scope_idempotency_uq UNIQUE (tenant_id, application_id, idempotency_key),
  CONSTRAINT guard_jobs_scope_id_uq UNIQUE (tenant_id, application_id, id)
);
CREATE INDEX IF NOT EXISTS guard_jobs_scope_status_idx ON guard_jobs (tenant_id, application_id, status);
CREATE INDEX IF NOT EXISTS guard_jobs_artifact_idx ON guard_jobs (artifact_id);

CREATE TABLE IF NOT EXISTS guard_job_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  job_id varchar(36) NOT NULL,
  event_type varchar(64) NOT NULL,
  payload jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guard_job_events_job_scope_fk FOREIGN KEY (tenant_id, application_id, job_id)
    REFERENCES guard_jobs(tenant_id, application_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS guard_job_events_job_idx ON guard_job_events (job_id, created_at);

COMMIT;
