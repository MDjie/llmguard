CREATE TABLE IF NOT EXISTS generated_content_derivatives (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_mark_id uuid NOT NULL REFERENCES generated_content_marks(id) ON DELETE RESTRICT,
  source_artifact_id varchar(36) NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  output_object_key varchar(900) NOT NULL,
  media_type varchar(128) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 3221225472),
  sha256 varchar(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  visible_mark_applied boolean NOT NULL,
  spoken_mark_applied boolean NOT NULL,
  metadata_embedded boolean NOT NULL,
  analyzer_version varchar(100) NOT NULL,
  created_by varchar(100) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, application_id, content_mark_id),
  UNIQUE (tenant_id, application_id, output_object_key)
);

CREATE INDEX IF NOT EXISTS generated_content_derivatives_source_idx
  ON generated_content_derivatives (tenant_id, application_id, source_artifact_id);
