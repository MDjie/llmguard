BEGIN;

CREATE TABLE IF NOT EXISTS rag_sources (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  artifact_id varchar(36) NOT NULL,
  source_uri_hash varchar(64) NOT NULL,
  source_type varchar(64) NOT NULL,
  trust_level integer NOT NULL DEFAULT 0 CHECK (trust_level BETWEEN 0 AND 100),
  classification integer NOT NULL DEFAULT 0 CHECK (classification BETWEEN 0 AND 10),
  acl jsonb DEFAULT '{}'::jsonb,
  state varchar(24) NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_sources_artifact_scope_fk FOREIGN KEY (tenant_id, application_id, artifact_id)
    REFERENCES artifacts(tenant_id, application_id, id) ON DELETE RESTRICT,
  CONSTRAINT rag_sources_state_ck CHECK (state IN ('pending','accepted','quarantined','deleted')),
  CONSTRAINT rag_sources_scope_artifact_uq UNIQUE (tenant_id, application_id, artifact_id),
  CONSTRAINT rag_sources_scope_id_uq UNIQUE (tenant_id, application_id, id)
);
CREATE INDEX IF NOT EXISTS rag_sources_scope_state_idx ON rag_sources (tenant_id, application_id, state);

CREATE TABLE IF NOT EXISTS rag_chunks (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  source_id varchar(36) NOT NULL,
  artifact_id varchar(36) NOT NULL,
  external_chunk_id varchar(256) NOT NULL,
  content_hash varchar(64) NOT NULL,
  provenance_signature varchar(128) NOT NULL,
  risk_action varchar(32) NOT NULL,
  risk_score integer NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  state varchar(24) NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_chunks_source_scope_fk FOREIGN KEY (tenant_id, application_id, source_id)
    REFERENCES rag_sources(tenant_id, application_id, id) ON DELETE CASCADE,
  CONSTRAINT rag_chunks_artifact_scope_fk FOREIGN KEY (tenant_id, application_id, artifact_id)
    REFERENCES artifacts(tenant_id, application_id, id) ON DELETE RESTRICT,
  CONSTRAINT rag_chunks_state_ck CHECK (state IN ('accepted','quarantined','deleted')),
  CONSTRAINT rag_chunks_scope_external_uq UNIQUE (tenant_id, application_id, external_chunk_id)
);
CREATE INDEX IF NOT EXISTS rag_chunks_source_idx ON rag_chunks (source_id);
CREATE INDEX IF NOT EXISTS rag_chunks_scope_state_idx ON rag_chunks (tenant_id, application_id, state);

CREATE TABLE IF NOT EXISTS rag_retrieval_audits (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  principal_id varchar(100) NOT NULL,
  trace_id varchar(128) NOT NULL,
  query_hash varchar(64) NOT NULL,
  candidate_count integer NOT NULL,
  accepted_count integer NOT NULL,
  rejected jsonb DEFAULT '[]'::jsonb,
  tainted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_retrieval_audits_scope_fk FOREIGN KEY (tenant_id, application_id)
    REFERENCES applications(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS rag_retrieval_audits_trace_idx ON rag_retrieval_audits (trace_id);

COMMIT;
