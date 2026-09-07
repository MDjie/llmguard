SET lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS decision_record_outbox (
  id varchar(64) PRIMARY KEY, tenant_id varchar(36) NOT NULL, application_id varchar(36) NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'), payload_digest varchar(64) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','PROJECTED')),
  created_at timestamptz NOT NULL DEFAULT now(), projected_at timestamptz,
  FOREIGN KEY (tenant_id,application_id) REFERENCES applications(tenant_id,id),
  UNIQUE(tenant_id,application_id,id)
);
CREATE INDEX IF NOT EXISTS decision_record_pending_idx ON decision_record_outbox(created_at) WHERE state='PENDING';
CREATE UNIQUE INDEX IF NOT EXISTS security_incidents_scope_id_uq ON security_incidents(tenant_id,application_id,id);
CREATE TABLE IF NOT EXISTS security_alerts (
  id varchar(64) PRIMARY KEY, tenant_id varchar(36) NOT NULL, application_id varchar(36) NOT NULL,
  record_id varchar(64) NOT NULL, source varchar(32) NOT NULL, source_id varchar(128) NOT NULL,
  request_id varchar(128), job_id varchar(128), trace_id varchar(128) NOT NULL, session_id varchar(128),
  decision_id varchar(128) NOT NULL, bundle_id varchar(128), stage varchar(128) NOT NULL, risk_id varchar(128) NOT NULL,
  category varchar(32) NOT NULL CHECK(category IN ('SECURITY_RISK','UNDETERMINED','SYSTEM_FAILURE')),
  action varchar(32) NOT NULL, score integer NOT NULL CHECK(score BETWEEN 0 AND 100),
  reason_codes jsonb NOT NULL DEFAULT '[]', evidence jsonb NOT NULL DEFAULT '[]', coverage jsonb NOT NULL DEFAULT '{}', incident_id uuid,
  occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,application_id) REFERENCES applications(tenant_id,id),
  FOREIGN KEY (tenant_id,application_id,record_id) REFERENCES decision_record_outbox(tenant_id,application_id,id),
  FOREIGN KEY (tenant_id,application_id,request_id) REFERENCES gateway_requests(tenant_id,application_id,id),
  FOREIGN KEY (tenant_id,application_id,job_id) REFERENCES guard_jobs(tenant_id,application_id,id),
  FOREIGN KEY (tenant_id,application_id,incident_id) REFERENCES security_incidents(tenant_id,application_id,id),
  UNIQUE(tenant_id,application_id,id)
);
ALTER TABLE security_alerts ADD COLUMN IF NOT EXISTS reason_codes jsonb NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS security_alerts_scope_time_idx ON security_alerts(tenant_id,application_id,occurred_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS security_alerts_request_idx ON security_alerts(tenant_id,application_id,request_id,decision_id);
CREATE OR REPLACE FUNCTION immutable_decision_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.application_id IS DISTINCT FROM OLD.application_id
    OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.state='PROJECTED' THEN RAISE EXCEPTION 'decision record is immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_decision_record_trigger ON decision_record_outbox;
CREATE TRIGGER immutable_decision_record_trigger BEFORE UPDATE OR DELETE ON decision_record_outbox FOR EACH ROW EXECUTE FUNCTION immutable_decision_record();
CREATE OR REPLACE FUNCTION immutable_security_alert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'incident_id') IS DISTINCT FROM (to_jsonb(OLD)-'incident_id')
    OR (OLD.incident_id IS NOT NULL AND NEW.incident_id IS DISTINCT FROM OLD.incident_id)
    THEN RAISE EXCEPTION 'alert evidence is immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_security_alert_trigger ON security_alerts;
CREATE TRIGGER immutable_security_alert_trigger BEFORE UPDATE OR DELETE ON security_alerts FOR EACH ROW EXECUTE FUNCTION immutable_security_alert();
CREATE INDEX IF NOT EXISTS gateway_requests_console_page_idx ON gateway_requests(tenant_id,application_id,date_trunc('milliseconds',created_at AT TIME ZONE 'UTC'),id);
CREATE INDEX IF NOT EXISTS gateway_steps_console_page_idx ON gateway_steps(tenant_id,application_id,request_id,date_trunc('milliseconds',created_at AT TIME ZONE 'UTC'),id);
RESET lock_timeout;
