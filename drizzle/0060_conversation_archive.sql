SET lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS conversation_archives (
  request_id varchar(128) PRIMARY KEY, tenant_id varchar(36) NOT NULL, application_id varchar(36) NOT NULL,
  conversation_id varchar(128) NOT NULL, subject_id varchar(128) NOT NULL, policy jsonb NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','COMMITTED','GAPPED','DELETE_PENDING','DELETED')),
  integrity jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 0,
  model_output_final_sequence integer CHECK(model_output_final_sequence >= 0), model_output_unavailable_reason varchar(128),
  media_complete boolean NOT NULL DEFAULT true, hold_until timestamptz,
  deletion_proof_id uuid REFERENCES data_deletion_proofs(proof_id), accepted_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, committed_at timestamptz, reconciled_at timestamptz,
  FOREIGN KEY(tenant_id,application_id,request_id) REFERENCES gateway_requests(tenant_id,application_id,id),
  UNIQUE(tenant_id,application_id,request_id), CHECK(extract(epoch from (expires_at - accepted_at)) >= 15552000)
);
ALTER TABLE conversation_archives ADD COLUMN IF NOT EXISTS deletion_proof_id uuid REFERENCES data_deletion_proofs(proof_id);
CREATE INDEX IF NOT EXISTS conversation_archives_scope_time_idx ON conversation_archives(tenant_id,application_id,accepted_at DESC,request_id DESC);
CREATE INDEX IF NOT EXISTS conversation_archives_session_idx ON conversation_archives(tenant_id,application_id,conversation_id,accepted_at,request_id);
CREATE TABLE IF NOT EXISTS archived_content_objects (
  id varchar(64) PRIMARY KEY, tenant_id varchar(36) NOT NULL, application_id varchar(36) NOT NULL, request_id varchar(128) NOT NULL,
  purpose varchar(32) NOT NULL CHECK(purpose IN ('RECEIVED_INPUT','MODEL_INPUT','MODEL_OUTPUT','RELEASED_OUTPUT')),
  sequence integer NOT NULL CHECK(sequence >= 0), representation varchar(32) NOT NULL,
  state varchar(24) NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','OBJECT_WRITTEN','MANIFEST_COMMITTED','INDEXED','DELETE_PENDING','DELETED')),
  source_hmac varchar(64) NOT NULL, content_hmac varchar(64) NOT NULL, ciphertext_sha256 varchar(64) NOT NULL,
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 16777216), object_key varchar(1024) NOT NULL, object_version varchar(1024), key_ids jsonb NOT NULL,
  spool jsonb, source_step_id varchar(128), event_sequence integer, range_start integer, range_end integer,
  attempt integer NOT NULL DEFAULT 0, error_code varchar(128), retry_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, object_written_at timestamptz, committed_at timestamptz, deleted_at timestamptz,
  FOREIGN KEY(tenant_id,application_id,request_id) REFERENCES conversation_archives(tenant_id,application_id,request_id),
  FOREIGN KEY(tenant_id,application_id,request_id,source_step_id) REFERENCES gateway_steps(tenant_id,application_id,request_id,id),
  UNIQUE(tenant_id,application_id,id), UNIQUE(tenant_id,application_id,request_id,purpose,sequence), UNIQUE(object_key),
  CHECK((range_start IS NULL AND range_end IS NULL) OR (range_start >= 0 AND range_end >= range_start)),
  CHECK(state NOT IN ('OBJECT_WRITTEN','MANIFEST_COMMITTED','INDEXED') OR object_version IS NOT NULL),
  CHECK(state <> 'PENDING' OR spool IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS archived_content_pending_idx ON archived_content_objects(retry_at,id) WHERE state IN ('PENDING','OBJECT_WRITTEN');
CREATE INDEX IF NOT EXISTS archived_content_request_idx ON archived_content_objects(tenant_id,application_id,request_id,purpose,sequence);
CREATE OR REPLACE FUNCTION protect_archived_content() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'archive tombstone must be retained'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','object_version','spool','attempt','error_code','retry_at','object_written_at','committed_at','deleted_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['state','object_version','spool','attempt','error_code','retry_at','object_written_at','committed_at','deleted_at'])
    OR (OLD.object_version IS NOT NULL AND NEW.object_version IS DISTINCT FROM OLD.object_version)
    OR (NEW.spool IS DISTINCT FROM OLD.spool AND NOT (NEW.spool IS NULL AND NEW.state IN ('MANIFEST_COMMITTED','INDEXED','DELETE_PENDING','DELETED')))
    THEN RAISE EXCEPTION 'archive object identity is immutable'; END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state='PENDING' AND NEW.state='OBJECT_WRITTEN') OR (OLD.state='OBJECT_WRITTEN' AND NEW.state='MANIFEST_COMMITTED') OR
    (OLD.state='MANIFEST_COMMITTED' AND NEW.state='INDEXED') OR (OLD.state IN ('MANIFEST_COMMITTED','INDEXED') AND NEW.state='DELETE_PENDING') OR
    (OLD.state='DELETE_PENDING' AND NEW.state='DELETED')) THEN RAISE EXCEPTION 'archive state transition invalid'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_archived_content_trigger ON archived_content_objects;
CREATE TRIGGER protect_archived_content_trigger BEFORE UPDATE OR DELETE ON archived_content_objects FOR EACH ROW EXECUTE FUNCTION protect_archived_content();
-- Operational tombstones stay immutable; an extant archive may still acquire a legal hold.
CREATE OR REPLACE FUNCTION guard_gateway_content_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.content_purged_at IS NOT NULL AND (
    NEW.content_purged_at IS DISTINCT FROM OLD.content_purged_at OR NEW.deletion_proof_id IS DISTINCT FROM OLD.deletion_proof_id OR NEW.session_snapshot IS NOT NULL) THEN
    RAISE EXCEPTION 'Purged gateway content cannot be restored';
  END IF;
  IF OLD.content_purged_at IS NOT NULL AND NEW.content_hold_until IS DISTINCT FROM OLD.content_hold_until AND NOT EXISTS(
    SELECT 1 FROM conversation_archives ca WHERE ca.tenant_id=NEW.tenant_id AND ca.application_id=NEW.application_id AND ca.request_id=NEW.id AND ca.state NOT IN ('DELETE_PENDING','DELETED')) THEN
    RAISE EXCEPTION 'Purged content without a retained archive cannot be held';
  END IF;
  IF NEW.content_purged_at IS NOT NULL AND (NEW.session_snapshot IS NOT NULL OR NEW.deletion_proof_id IS NULL OR NOT NEW.session_finalized) THEN
    RAISE EXCEPTION 'Gateway content deletion requires a proof and finalized session';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE content_access_requests DROP CONSTRAINT IF EXISTS content_access_requests_resource_ck;
ALTER TABLE content_access_requests ADD CONSTRAINT content_access_requests_resource_ck CHECK(resource_type IN ('INCIDENT_EVIDENCE','ARCHIVED_CONTENT'));
CREATE OR REPLACE FUNCTION guard_archive_access_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.resource_type='ARCHIVED_CONTENT' AND NOT EXISTS(SELECT 1 FROM archived_content_objects o WHERE o.tenant_id=NEW.tenant_id AND o.application_id=NEW.application_id AND o.id=NEW.resource_id AND o.content_hmac=NEW.source_digest) THEN
    RAISE EXCEPTION 'archive grant source scope mismatch'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_archive_access_scope_trigger ON content_access_requests;
CREATE TRIGGER guard_archive_access_scope_trigger BEFORE INSERT ON content_access_requests FOR EACH ROW EXECUTE FUNCTION guard_archive_access_scope();
RESET lock_timeout;
