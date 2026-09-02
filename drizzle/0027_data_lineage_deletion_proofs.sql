CREATE TABLE IF NOT EXISTS data_lineage_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  source_type varchar(64) NOT NULL CHECK (source_type ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  source_id varchar(256) NOT NULL,
  target_type varchar(64) NOT NULL CHECK (target_type ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  target_id varchar(256) NOT NULL,
  operation varchar(64) NOT NULL CHECK (operation ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  processor_id varchar(256) NOT NULL,
  processor_version varchar(256) NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_hash varchar(64) NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_lineage_edges_identity_uq UNIQUE (
    tenant_id, application_id, source_type, source_id,
    target_type, target_id, operation, processor_id
  )
);

CREATE INDEX IF NOT EXISTS data_lineage_edges_source_idx
  ON data_lineage_edges (tenant_id, application_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS data_lineage_edges_target_idx
  ON data_lineage_edges (tenant_id, application_id, target_type, target_id);

CREATE TABLE IF NOT EXISTS data_deletion_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proof_id uuid NOT NULL UNIQUE,
  version varchar(16) NOT NULL CHECK (version = '1.0'),
  cutoff timestamptz NOT NULL,
  manifest jsonb NOT NULL,
  phases jsonb NOT NULL,
  completed_at timestamptz NOT NULL,
  key_id varchar(64) NOT NULL,
  signature varchar(64) NOT NULL CHECK (signature ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_deletion_proofs_nonempty_manifest
    CHECK (jsonb_typeof(manifest) = 'array' AND jsonb_array_length(manifest) > 0),
  CONSTRAINT data_deletion_proofs_phase_object
    CHECK (jsonb_typeof(phases) = 'object')
);

CREATE INDEX IF NOT EXISTS data_deletion_proofs_cutoff_idx
  ON data_deletion_proofs (cutoff);
CREATE INDEX IF NOT EXISTS data_deletion_proofs_completed_idx
  ON data_deletion_proofs (completed_at);

COMMENT ON TABLE data_lineage_edges IS
  'Tenant-scoped, hash-bound provenance edges across artifacts, derivatives, RAG and content marks';
COMMENT ON TABLE data_deletion_proofs IS
  'HMAC-signed batch evidence for retention deletion, including per-store completion state';
