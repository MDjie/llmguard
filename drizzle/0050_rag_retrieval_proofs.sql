SET LOCAL lock_timeout = '5s';
ALTER TABLE rag_retrieval_audits ADD COLUMN IF NOT EXISTS request_id varchar(128);
ALTER TABLE rag_retrieval_audits ADD COLUMN IF NOT EXISTS bundle_id varchar(36);
ALTER TABLE rag_retrieval_audits ADD COLUMN IF NOT EXISTS retrieval_proof jsonb;
CREATE INDEX IF NOT EXISTS rag_retrieval_scope_request_idx ON rag_retrieval_audits(tenant_id,application_id,request_id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rag_retrieval_scoped_bundle_fk') THEN
    ALTER TABLE rag_retrieval_audits ADD CONSTRAINT rag_retrieval_scoped_bundle_fk
      FOREIGN KEY(tenant_id,application_id,bundle_id) REFERENCES policy_bundles(tenant_id,application_id,id) NOT VALID;
  END IF;
END $$;
