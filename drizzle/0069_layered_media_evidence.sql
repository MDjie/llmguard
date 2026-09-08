CREATE TABLE IF NOT EXISTS media_evidence_chunks (
 tenant_id varchar(36) NOT NULL, application_id varchar(36) NOT NULL, id varchar(64) PRIMARY KEY,
 snapshot_id varchar(64) NOT NULL REFERENCES media_evidence_snapshots(id) DEFERRABLE INITIALLY DEFERRED,
 ordinal integer NOT NULL CHECK(ordinal >= 0 AND ordinal < 64), plaintext_sha256 varchar(64) NOT NULL,
 plaintext_bytes integer NOT NULL CHECK(plaintext_bytes > 0 AND plaintext_bytes <= 1048576),
 ciphertext_sha256 varchar(64) NOT NULL, size_bytes integer NOT NULL,
 object_key text NOT NULL, object_version text, spool jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS media_evidence_chunks_snapshot_ordinal ON media_evidence_chunks(snapshot_id, ordinal);

CREATE UNIQUE INDEX IF NOT EXISTS media_evidence_scope_id_uq ON media_evidence_snapshots(tenant_id,application_id,id);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='media_evidence_chunks_scope_fk') THEN
 ALTER TABLE media_evidence_chunks ADD CONSTRAINT media_evidence_chunks_scope_fk FOREIGN KEY(tenant_id,application_id,snapshot_id) REFERENCES media_evidence_snapshots(tenant_id,application_id,id) DEFERRABLE INITIALLY DEFERRED;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION protect_media_evidence_chunk() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'evidence chunk tombstone must be retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['object_version','spool']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['object_version','spool'])
 OR (OLD.object_version IS NOT NULL AND NEW.object_version IS DISTINCT FROM OLD.object_version)
 OR (NEW.spool IS DISTINCT FROM OLD.spool AND NOT(NEW.spool IS NULL AND NEW.object_version IS NOT NULL))
 THEN RAISE EXCEPTION 'evidence chunk identity is immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_media_evidence_chunk_trigger ON media_evidence_chunks;
CREATE TRIGGER protect_media_evidence_chunk_trigger BEFORE UPDATE OR DELETE ON media_evidence_chunks FOR EACH ROW EXECUTE FUNCTION protect_media_evidence_chunk();
