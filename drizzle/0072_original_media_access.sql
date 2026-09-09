-- A separate grant authorizes an original source (page 0) or one PDF page.
-- Existing grants keep their immutable resource identity and cannot gain this scope.
ALTER TABLE content_access_requests DROP CONSTRAINT IF EXISTS content_access_requests_resource_ck;
ALTER TABLE content_access_requests ADD CONSTRAINT content_access_requests_resource_ck
 CHECK(resource_type IN('INCIDENT_EVIDENCE','ARCHIVED_CONTENT','MEDIA_EVIDENCE','MEDIA_ORIGINAL'));
CREATE OR REPLACE FUNCTION guard_original_media_access_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_page integer;
BEGIN
 IF NEW.resource_type <> 'MEDIA_ORIGINAL' THEN RETURN NEW; END IF;
 IF NEW.resource_id !~ '^[a-f0-9]{64}:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}:(0|[1-9][0-9]{0,3})$'
 THEN RAISE EXCEPTION 'original media resource selector invalid'; END IF;
 selected_page := split_part(NEW.resource_id,':',3)::integer;
 IF selected_page > 2000 OR NOT EXISTS(
  SELECT 1 FROM media_evidence_snapshots s
  JOIN guard_jobs j ON j.tenant_id=s.tenant_id AND j.application_id=s.application_id AND j.id=s.job_id
  JOIN artifacts a ON a.tenant_id=j.tenant_id AND a.application_id=j.application_id AND a.owner_id=j.owner_id
  WHERE s.tenant_id=NEW.tenant_id AND s.application_id=NEW.application_id
   AND s.id=split_part(NEW.resource_id,':',1) AND a.id=split_part(NEW.resource_id,':',2)
   AND s.state='READY' AND (s.expires_at>now() OR s.hold_until>now())
   AND j.status='completed' AND j.cancelled_at IS NULL AND a.state='accepted' AND a.purged_at IS NULL AND a.content_expires_at>now()
   AND ((j.job_type IN('intake','native_joint') AND j.execution_binding->'artifacts' @> jsonb_build_array(jsonb_build_object('id',a.id,'sha256',a.verified_sha256)))
      OR (j.job_type NOT IN('intake','native_joint') AND j.artifact_id=a.id))
   AND ((a.kind='DOCUMENT' AND a.detected_media_type='application/pdf' AND selected_page>0)
      OR (a.kind IN('IMAGE','AUDIO','VIDEO') AND selected_page=0))
 ) THEN RAISE EXCEPTION 'original media grant scope mismatch'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_original_media_access_scope_trigger ON content_access_requests;
CREATE TRIGGER guard_original_media_access_scope_trigger BEFORE INSERT ON content_access_requests
 FOR EACH ROW EXECUTE FUNCTION guard_original_media_access_scope();
