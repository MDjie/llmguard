CREATE TABLE IF NOT EXISTS audit_export_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_event_id uuid NOT NULL REFERENCES security_audit_events(id) ON DELETE RESTRICT,
  tenant_id varchar(100),
  application_id varchar(100),
  destination_type varchar(16) NOT NULL CHECK (destination_type IN ('syslog','kafka')),
  destination varchar(500) NOT NULL,
  payload jsonb NOT NULL,
  state varchar(24) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','failed','delivered','terminal_failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  delivered_at timestamptz,
  last_error varchar(500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (audit_event_id, destination_type, destination)
);

CREATE INDEX IF NOT EXISTS audit_export_outbox_dispatch_idx
  ON audit_export_outbox (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS audit_export_outbox_scope_idx
  ON audit_export_outbox (tenant_id, application_id, created_at);

COMMENT ON TABLE audit_export_outbox IS
  'Durable delivery outbox for filtered Syslog and Kafka audit export; delivery state is intentionally mutable.';
