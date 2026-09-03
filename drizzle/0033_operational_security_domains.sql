CREATE TABLE IF NOT EXISTS operational_security_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  domain varchar(32) NOT NULL CHECK (
    domain IN ('AUDIT', 'RUNTIME', 'NETWORK_SECURITY', 'MODEL_SECURITY')
  ),
  event_type varchar(128) NOT NULL CHECK (event_type ~ '^[A-Z][A-Z0-9_.-]{0,127}$'),
  severity varchar(16) NOT NULL CHECK (
    severity IN ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')
  ),
  outcome varchar(32) NOT NULL,
  occurred_at timestamptz NOT NULL,
  tenant_id varchar(100),
  application_id varchar(100),
  principal_id varchar(100),
  trace_id varchar(128),
  request_id varchar(128),
  action varchar(64),
  source varchar(128) NOT NULL,
  network jsonb,
  model jsonb,
  evidence_digest varchar(64) NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  content_hmac varchar(64) CHECK (content_hmac IS NULL OR content_hmac ~ '^[a-f0-9]{64}$'),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operational_security_events_time_id_uq UNIQUE (occurred_at, id),
  CONSTRAINT operational_security_events_network_context_check CHECK (
    domain <> 'NETWORK_SECURITY' OR network IS NOT NULL
  ),
  CONSTRAINT operational_security_events_model_context_check CHECK (
    domain <> 'MODEL_SECURITY' OR model IS NOT NULL
  )
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS operational_security_events_default
  PARTITION OF operational_security_events DEFAULT;

CREATE INDEX IF NOT EXISTS operational_security_events_scope_time_idx
  ON operational_security_events (tenant_id, application_id, occurred_at);
CREATE INDEX IF NOT EXISTS operational_security_events_domain_time_idx
  ON operational_security_events (domain, occurred_at);

CREATE OR REPLACE FUNCTION ensure_operational_security_event_partition(p_month date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  month_start date := date_trunc('month', p_month)::date;
  month_end date := (date_trunc('month', p_month) + interval '1 month')::date;
  partition_name text := 'operational_security_events_' || to_char(month_start, 'YYYYMM');
BEGIN
  IF month_start < date_trunc('month', current_date) - interval '1 month'
     OR month_start > date_trunc('month', current_date) + interval '13 months' THEN
    RAISE EXCEPTION 'partition month is outside the allowed maintenance window';
  END IF;
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF operational_security_events FOR VALUES FROM (%L) TO (%L)',
    partition_name, month_start, month_end
  );
END;
$$;

SELECT ensure_operational_security_event_partition(current_date);
SELECT ensure_operational_security_event_partition(
  (date_trunc('month', current_date) + interval '1 month')::date
);

CREATE OR REPLACE FUNCTION reject_operational_security_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operational security events are immutable';
END;
$$;

DROP TRIGGER IF EXISTS operational_security_events_immutable
  ON operational_security_events;
CREATE TRIGGER operational_security_events_immutable
  BEFORE UPDATE OR DELETE ON operational_security_events
  FOR EACH ROW EXECUTE FUNCTION reject_operational_security_event_mutation();
