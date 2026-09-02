CREATE TABLE IF NOT EXISTS security_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event varchar(160) NOT NULL,
  outcome varchar(16) NOT NULL,
  status integer NOT NULL,
  request_id varchar(128) NOT NULL,
  trace_id varchar(128) NOT NULL,
  method varchar(16) NOT NULL,
  path varchar(500) NOT NULL,
  latency_ms integer NOT NULL,
  principal_id varchar(100),
  tenant_id varchar(100),
  application_id varchar(100),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_audit_events_created_at_idx
  ON security_audit_events (created_at);
CREATE INDEX IF NOT EXISTS security_audit_events_principal_id_idx
  ON security_audit_events (principal_id);
CREATE INDEX IF NOT EXISTS security_audit_events_event_idx
  ON security_audit_events (event);
