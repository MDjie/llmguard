SET lock_timeout = '5s';
CREATE UNIQUE INDEX IF NOT EXISTS applications_tenant_id_uq ON applications(tenant_id,id);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS owner varchar(200);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS department varchar(200);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS environment varchar(32) NOT NULL DEFAULT 'development';
ALTER TABLE applications ADD COLUMN IF NOT EXISTS data_class varchar(32) NOT NULL DEFAULT 'internal';
ALTER TABLE applications ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 1;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS integration_state varchar(32) NOT NULL DEFAULT 'DRAFT';
ALTER TABLE applications ADD COLUMN IF NOT EXISTS model_routes jsonb NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS gateway_runtime_snapshots (
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  id varchar(128) PRIMARY KEY,
  generation integer NOT NULL,
  bundle_id varchar(128) NOT NULL,
  manifest jsonb NOT NULL,
  digest varchar(64) NOT NULL,
  signature text NOT NULL,
  key_id varchar(128) NOT NULL,
  state varchar(32) NOT NULL DEFAULT 'PREPARED',
  valid_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,application_id) REFERENCES applications(tenant_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_runtime_snapshots_generation_uq ON gateway_runtime_snapshots(tenant_id,application_id,generation);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_runtime_snapshots_scope_id_uq ON gateway_runtime_snapshots(tenant_id,application_id,id);
CREATE INDEX IF NOT EXISTS gateway_runtime_snapshots_scope_time_idx ON gateway_runtime_snapshots(tenant_id,application_id,created_at);
CREATE TABLE IF NOT EXISTS gateway_requests (
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  id varchar(128) PRIMARY KEY,
  idempotency_key varchar(128) NOT NULL,
  request_hmac varchar(64) NOT NULL,
  snapshot_id varchar(128) NOT NULL,
  subject_id varchar(128) NOT NULL,
  session_id varchar(128),
  state varchar(40) NOT NULL DEFAULT 'AUTHORIZED',
  step_count integer NOT NULL DEFAULT 0,
  last_event_seq integer NOT NULL DEFAULT 0,
  auth_context jsonb NOT NULL,
  session_snapshot jsonb,
  response_ref varchar(256),
  session_finalized boolean NOT NULL DEFAULT false,
  console_assertion_hmac varchar(64),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,application_id) REFERENCES applications(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,application_id,snapshot_id) REFERENCES gateway_runtime_snapshots(tenant_id,application_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_requests_idempotency_uq ON gateway_requests(tenant_id,application_id,idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_requests_scope_id_uq ON gateway_requests(tenant_id,application_id,id);
CREATE INDEX IF NOT EXISTS gateway_requests_scope_time_idx ON gateway_requests(tenant_id,application_id,created_at);
CREATE TABLE IF NOT EXISTS gateway_steps (
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  id varchar(128) PRIMARY KEY,
  request_id varchar(128) NOT NULL,
  stage varchar(32) NOT NULL,
  stream_seq integer NOT NULL,
  attempt_kind varchar(16) NOT NULL,
  decision_id varchar(128),
  input_hmac varchar(64) NOT NULL,
  output_hmac varchar(64),
  action varchar(32),
  coverage varchar(16) NOT NULL DEFAULT 'UNKNOWN',
  status varchar(16) NOT NULL DEFAULT 'RUNNING',
  latency_ms integer,
  model_versions jsonb NOT NULL DEFAULT '[]',
  decision_envelope jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,application_id) REFERENCES applications(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,application_id,request_id) REFERENCES gateway_requests(tenant_id,application_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_steps_step_uq ON gateway_steps(tenant_id,application_id,request_id,stage,stream_seq,attempt_kind);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_steps_scope_id_uq ON gateway_steps(tenant_id,application_id,id);
CREATE INDEX IF NOT EXISTS gateway_steps_scope_time_idx ON gateway_steps(tenant_id,application_id,created_at);
CREATE TABLE IF NOT EXISTS gateway_execution_events (
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  id varchar(128) PRIMARY KEY,
  request_id varchar(128) NOT NULL,
  step_id varchar(128),
  event_seq integer NOT NULL,
  kind varchar(40) NOT NULL,
  range_start integer,
  range_end integer,
  payload_hmac varchar(64),
  snapshot_id varchar(128) NOT NULL,
  event_hmac varchar(64) NOT NULL,
  actual_action varchar(32),
  reason_code varchar(128),
  decision_id varchar(128),
  recheck_decision_id varchar(128),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,application_id) REFERENCES applications(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,application_id,snapshot_id) REFERENCES gateway_runtime_snapshots(tenant_id,application_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,application_id,request_id) REFERENCES gateway_requests(tenant_id,application_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_execution_events_event_uq ON gateway_execution_events(tenant_id,application_id,request_id,event_seq);
CREATE INDEX IF NOT EXISTS gateway_execution_events_scope_time_idx ON gateway_execution_events(tenant_id,application_id,created_at);
CREATE TABLE IF NOT EXISTS gateway_node_acks (
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  id varchar(128) PRIMARY KEY,
  snapshot_id varchar(128) NOT NULL,
  node_id varchar(128) NOT NULL,
  digest varchar(64) NOT NULL,
  state varchar(16) NOT NULL,
  reason_code varchar(128),
  loaded_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,application_id) REFERENCES applications(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,application_id,snapshot_id) REFERENCES gateway_runtime_snapshots(tenant_id,application_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_node_acks_node_uq ON gateway_node_acks(tenant_id,application_id,snapshot_id,node_id);
CREATE INDEX IF NOT EXISTS gateway_node_acks_scope_time_idx ON gateway_node_acks(tenant_id,application_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_requests_console_assertion_uq ON gateway_requests(tenant_id,application_id,console_assertion_hmac);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_requests_session_lease_uq ON gateway_requests(tenant_id,application_id,session_id) WHERE session_id IS NOT NULL AND session_finalized = false;
CREATE OR REPLACE FUNCTION gateway_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.digest IS DISTINCT FROM OLD.digest OR NEW.signature IS DISTINCT FROM OLD.signature OR NEW.key_id IS DISTINCT FROM OLD.key_id OR NEW.generation IS DISTINCT FROM OLD.generation OR NEW.valid_until IS DISTINCT FROM OLD.valid_until OR NEW.bundle_id IS DISTINCT FROM OLD.bundle_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.application_id IS DISTINCT FROM OLD.application_id THEN RAISE EXCEPTION 'gateway snapshot content is immutable'; END IF; IF OLD.state = 'REVOKED' AND NEW.state <> 'REVOKED' THEN RAISE EXCEPTION 'revoked snapshot cannot be reactivated'; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS gateway_snapshot_immutable_trigger ON gateway_runtime_snapshots;
CREATE TRIGGER gateway_snapshot_immutable_trigger BEFORE UPDATE ON gateway_runtime_snapshots FOR EACH ROW EXECUTE FUNCTION gateway_snapshot_immutable();
RESET lock_timeout;
