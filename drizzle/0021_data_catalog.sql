CREATE TABLE IF NOT EXISTS data_catalog_entries (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), asset_code varchar(64) NOT NULL, name varchar(200) NOT NULL,
  category varchar(32) NOT NULL CHECK (category IN ('CUSTOMER','POLICY','HEALTH','PROPERTY','MODEL','PROMPT','LOG','SECRET','OTHER')),
  classification_level varchar(32) NOT NULL CHECK (classification_level IN ('PUBLIC','INTERNAL','SENSITIVE','HIGHLY_SENSITIVE')),
  classification_standards jsonb NOT NULL, owner_id varchar(100) NOT NULL, steward_id varchar(100),
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 1 AND 3650), source_system varchar(200) NOT NULL,
  storage_location varchar(500) NOT NULL, legal_basis varchar(500), control_policy jsonb NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_by varchar(100) NOT NULL, updated_by varchar(100) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, application_id, asset_code)
);
CREATE INDEX IF NOT EXISTS data_catalog_classification_idx ON data_catalog_entries (classification_level);

CREATE TABLE IF NOT EXISTS data_catalog_history (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), catalog_entry_id uuid NOT NULL REFERENCES data_catalog_entries(id) ON DELETE RESTRICT,
  version integer NOT NULL, actor_id varchar(100) NOT NULL, change_type varchar(24) NOT NULL,
  previous_snapshot jsonb, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (catalog_entry_id, version)
);
CREATE OR REPLACE FUNCTION guardllm_reject_data_catalog_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'data_catalog_history is append-only'; END; $$;
DROP TRIGGER IF EXISTS data_catalog_history_append_only ON data_catalog_history;
CREATE TRIGGER data_catalog_history_append_only BEFORE UPDATE OR DELETE ON data_catalog_history
FOR EACH ROW EXECUTE FUNCTION guardllm_reject_data_catalog_history_mutation();
