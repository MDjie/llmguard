BEGIN;

ALTER TABLE guard_jobs ADD COLUMN IF NOT EXISTS context_artifact_id varchar(36);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'guard_jobs_context_artifact_scope_fk') THEN
    ALTER TABLE guard_jobs ADD CONSTRAINT guard_jobs_context_artifact_scope_fk
      FOREIGN KEY (tenant_id, application_id, context_artifact_id)
      REFERENCES artifacts(tenant_id, application_id, id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
ALTER TABLE guard_jobs VALIDATE CONSTRAINT guard_jobs_context_artifact_scope_fk;

CREATE TABLE IF NOT EXISTS artifact_derivatives (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  artifact_id varchar(128) NOT NULL,
  parent_artifact_id varchar(36) NOT NULL,
  view_id varchar(100) NOT NULL,
  transform varchar(100) NOT NULL,
  parameters jsonb DEFAULT '{}'::jsonb,
  coordinate_mapping jsonb DEFAULT '{}'::jsonb,
  sha256 varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifact_derivatives_parent_scope_fk FOREIGN KEY (tenant_id, application_id, parent_artifact_id)
    REFERENCES artifacts(tenant_id, application_id, id) ON DELETE CASCADE,
  CONSTRAINT artifact_derivatives_scope_view_uq UNIQUE (tenant_id, application_id, parent_artifact_id, view_id)
);
CREATE INDEX IF NOT EXISTS artifact_derivatives_parent_idx ON artifact_derivatives (parent_artifact_id);

CREATE TABLE IF NOT EXISTS multimodal_findings (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  job_id varchar(36) NOT NULL,
  risk_type varchar(128) NOT NULL,
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  action varchar(32) NOT NULL,
  cooperative_attack boolean NOT NULL DEFAULT false,
  evidence jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT multimodal_findings_job_scope_fk FOREIGN KEY (tenant_id, application_id, job_id)
    REFERENCES guard_jobs(tenant_id, application_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS multimodal_findings_job_idx ON multimodal_findings (job_id);

COMMIT;
