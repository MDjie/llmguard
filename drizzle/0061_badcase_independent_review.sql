CREATE UNIQUE INDEX IF NOT EXISTS badcase_feedback_scope_id_uq ON badcase_feedback (tenant_id,application_id,id);
CREATE TABLE IF NOT EXISTS badcase_feedback_reviews (
 tenant_id varchar(36) NOT NULL, application_id varchar(36) NOT NULL,
 feedback_id uuid NOT NULL PRIMARY KEY, submitted_by varchar(100) NOT NULL, reviewed_by varchar(100) NOT NULL,
 decision varchar(16) NOT NULL CHECK (decision IN ('ACCEPT','REJECT')), reason varchar(500) NOT NULL,
 source_digest varchar(64) NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (submitted_by <> reviewed_by),
 FOREIGN KEY (tenant_id,application_id,feedback_id) REFERENCES badcase_feedback (tenant_id,application_id,id) ON DELETE RESTRICT
);
CREATE OR REPLACE FUNCTION guard_badcase_review_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'badcase review is immutable'; END $$;
DROP TRIGGER IF EXISTS badcase_review_immutable ON badcase_feedback_reviews;
CREATE TRIGGER badcase_review_immutable BEFORE UPDATE OR DELETE ON badcase_feedback_reviews FOR EACH ROW EXECUTE FUNCTION guard_badcase_review_immutable();
CREATE INDEX IF NOT EXISTS badcase_review_scope_time_idx ON badcase_feedback_reviews (tenant_id,application_id,created_at,feedback_id);
