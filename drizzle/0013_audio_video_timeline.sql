BEGIN;

CREATE TABLE IF NOT EXISTS media_timeline_findings (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  job_id varchar(36) NOT NULL,
  risk_type varchar(128) NOT NULL,
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  action varchar(32) NOT NULL,
  start_ms bigint,
  end_ms bigint,
  frame_index integer,
  region jsonb,
  content_hmac varchar(64),
  reason_code varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_timeline_findings_job_scope_fk FOREIGN KEY (tenant_id, application_id, job_id)
    REFERENCES guard_jobs(tenant_id, application_id, id) ON DELETE CASCADE,
  CONSTRAINT media_timeline_findings_time_ck CHECK (
    (start_ms IS NULL AND end_ms IS NULL) OR (start_ms >= 0 AND end_ms >= start_ms)
  )
);
CREATE INDEX IF NOT EXISTS media_timeline_findings_job_time_idx
  ON media_timeline_findings (job_id, start_ms);

COMMIT;
