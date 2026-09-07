SET lock_timeout='5s';
CREATE TABLE IF NOT EXISTS media_evidence_snapshots(
 id varchar(64) PRIMARY KEY,tenant_id varchar(36) NOT NULL,application_id varchar(36) NOT NULL,job_id varchar(36) NOT NULL,
 state varchar(20) NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','OBJECT_WRITTEN','READY','DELETE_PENDING','DELETED')),
 content_hmac varchar(64) NOT NULL,ciphertext_sha256 varchar(64) NOT NULL,size_bytes integer NOT NULL CHECK(size_bytes>0),
 object_key text NOT NULL,object_version text,key_ids jsonb NOT NULL,spool jsonb,
 error_code varchar(128),attempt integer NOT NULL DEFAULT 0,retry_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,hold_until timestamptz,
 verified_at timestamptz,deleted_at timestamptz,deletion_proof jsonb,
 UNIQUE(tenant_id,application_id,id),UNIQUE(tenant_id,application_id,job_id),
 FOREIGN KEY(tenant_id,application_id,job_id) REFERENCES guard_jobs(tenant_id,application_id,id)
);
CREATE INDEX IF NOT EXISTS media_evidence_recovery_idx ON media_evidence_snapshots(state,retry_at);
CREATE OR REPLACE FUNCTION protect_media_evidence_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'evidence tombstone must be retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','object_version','spool','attempt','error_code','retry_at','hold_until','verified_at','deleted_at','deletion_proof']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','object_version','spool','attempt','error_code','retry_at','hold_until','verified_at','deleted_at','deletion_proof'])
    OR (OLD.object_version IS NOT NULL AND NEW.object_version IS DISTINCT FROM OLD.object_version)
    OR (NEW.spool IS DISTINCT FROM OLD.spool AND NOT (NEW.spool IS NULL AND NEW.state='READY'))
    OR (OLD.state IN ('DELETE_PENDING','DELETED') AND NEW.hold_until IS DISTINCT FROM OLD.hold_until)
    OR (OLD.deletion_proof IS NOT NULL AND NEW.deletion_proof IS DISTINCT FROM OLD.deletion_proof)
 THEN RAISE EXCEPTION 'evidence snapshot identity is immutable'; END IF;
 IF NEW.state IS DISTINCT FROM OLD.state AND NOT ((OLD.state='PENDING' AND NEW.state='OBJECT_WRITTEN') OR(OLD.state='OBJECT_WRITTEN' AND NEW.state='READY') OR(OLD.state='READY' AND NEW.state='DELETE_PENDING') OR(OLD.state='DELETE_PENDING' AND NEW.state='DELETED')) THEN RAISE EXCEPTION 'evidence state transition invalid'; END IF;
 RETURN NEW; END $$;
DROP TRIGGER IF EXISTS protect_media_evidence_snapshot_trigger ON media_evidence_snapshots;
CREATE TRIGGER protect_media_evidence_snapshot_trigger BEFORE UPDATE OR DELETE ON media_evidence_snapshots FOR EACH ROW EXECUTE FUNCTION protect_media_evidence_snapshot();
ALTER TABLE content_access_requests DROP CONSTRAINT IF EXISTS content_access_requests_resource_ck;
ALTER TABLE content_access_requests ADD CONSTRAINT content_access_requests_resource_ck CHECK(resource_type IN('INCIDENT_EVIDENCE','ARCHIVED_CONTENT','MEDIA_EVIDENCE'));
CREATE OR REPLACE FUNCTION guard_media_evidence_access_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.resource_type='MEDIA_EVIDENCE' AND NOT EXISTS(SELECT 1 FROM media_evidence_snapshots m WHERE m.tenant_id=NEW.tenant_id AND m.application_id=NEW.application_id AND m.id=NEW.resource_id AND m.content_hmac=NEW.source_digest) THEN RAISE EXCEPTION 'media evidence grant scope mismatch'; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS guard_media_evidence_access_scope_trigger ON content_access_requests;
CREATE TRIGGER guard_media_evidence_access_scope_trigger BEFORE INSERT ON content_access_requests FOR EACH ROW EXECUTE FUNCTION guard_media_evidence_access_scope();
RESET lock_timeout;
