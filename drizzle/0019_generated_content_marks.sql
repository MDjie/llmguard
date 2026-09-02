CREATE TABLE IF NOT EXISTS generated_content_marks (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id uuid NOT NULL,
  modality varchar(24) NOT NULL,
  service_provider varchar(128) NOT NULL,
  generated_content boolean NOT NULL DEFAULT true,
  explicit_mark_applied boolean NOT NULL,
  metadata jsonb NOT NULL,
  metadata_signature varchar(128) NOT NULL,
  hash_key_id varchar(64) NOT NULL,
  content_hash varchar(64) NOT NULL,
  exemption_subject_id varchar(100),
  exemption_agreement_version varchar(64),
  exemption_purpose varchar(500),
  retain_until timestamptz,
  created_by varchar(100) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generated_content_marks_exemption_ck CHECK (
    explicit_mark_applied OR (
      exemption_subject_id IS NOT NULL AND
      exemption_agreement_version IS NOT NULL AND
      exemption_purpose IS NOT NULL AND
      retain_until >= created_at + interval '180 days'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS generated_content_marks_scope_content_uq
  ON generated_content_marks (tenant_id, application_id, content_id);
CREATE INDEX IF NOT EXISTS generated_content_marks_created_at_idx ON generated_content_marks (created_at);
CREATE INDEX IF NOT EXISTS generated_content_marks_retain_until_idx ON generated_content_marks (retain_until);
