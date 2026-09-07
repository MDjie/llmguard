SET lock_timeout='5s';
CREATE UNIQUE INDEX IF NOT EXISTS content_access_requests_scope_id_uq ON content_access_requests(tenant_id,application_id,id);
CREATE TABLE IF NOT EXISTS feedback_candidate_exports(
 id varchar(64) PRIMARY KEY,tenant_id varchar(36) NOT NULL,application_id varchar(36) NOT NULL,
 feedback_id uuid NOT NULL,grant_id uuid NOT NULL,resource_type varchar(32) NOT NULL,resource_id varchar(128) NOT NULL,
 source_digest varchar(64) NOT NULL,candidate_digest varchar(64) NOT NULL,created_by varchar(100) NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,application_id,grant_id),
 FOREIGN KEY(tenant_id,application_id,feedback_id) REFERENCES badcase_feedback(tenant_id,application_id,id),
 FOREIGN KEY(tenant_id,application_id,grant_id) REFERENCES content_access_requests(tenant_id,application_id,id)
);
CREATE OR REPLACE FUNCTION immutable_feedback_candidate_export() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'feedback candidate export is immutable'; END $$;
DROP TRIGGER IF EXISTS immutable_feedback_candidate_export_trigger ON feedback_candidate_exports;
CREATE TRIGGER immutable_feedback_candidate_export_trigger BEFORE UPDATE OR DELETE ON feedback_candidate_exports FOR EACH ROW EXECUTE FUNCTION immutable_feedback_candidate_export();
RESET lock_timeout;
