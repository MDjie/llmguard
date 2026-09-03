ALTER TABLE guard_session_risk_states
  ADD COLUMN IF NOT EXISTS hot_window_token_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokenizer_id varchar(256),
  ADD COLUMN IF NOT EXISTS last_event_sequence bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS guard_memory_events (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id varchar(128) NOT NULL,
  sequence_number bigint NOT NULL CHECK (sequence_number > 0),
  event_type varchar(40) NOT NULL,
  content_hash varchar(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  payload_envelopes jsonb NOT NULL CHECK (
    jsonb_typeof(payload_envelopes) = 'array' AND jsonb_array_length(payload_envelopes) > 0
  ),
  source_envelope_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  parent_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  sensitivity_labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  risk_labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  policy_bundle_id varchar(36) NOT NULL,
  decision_id varchar(128) NOT NULL,
  tokenizer_id varchar(256),
  token_count integer CHECK (token_count IS NULL OR token_count >= 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, application_id, session_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS guard_memory_events_scope_session_idx
  ON guard_memory_events (tenant_id, application_id, session_id, created_at);
CREATE INDEX IF NOT EXISTS guard_memory_events_expires_idx
  ON guard_memory_events (expires_at);

CREATE TABLE IF NOT EXISTS guard_memory_risk_ledgers (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id varchar(128) NOT NULL,
  state_version integer NOT NULL DEFAULT 1 CHECK (state_version > 0),
  risk_state varchar(24) NOT NULL DEFAULT 'NORMAL',
  max_risk_level varchar(20) NOT NULL DEFAULT 'NONE',
  cumulative_score integer NOT NULL DEFAULT 0 CHECK (cumulative_score >= 0),
  entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  sensitivity_labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_envelope_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_decision_id varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, application_id, session_id)
);

CREATE INDEX IF NOT EXISTS guard_memory_risk_ledgers_expires_idx
  ON guard_memory_risk_ledgers (expires_at);

CREATE TABLE IF NOT EXISTS guard_memory_graph_edges (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id varchar(128) NOT NULL,
  from_node_type varchar(32) NOT NULL,
  from_node_id varchar(128) NOT NULL,
  to_node_type varchar(32) NOT NULL,
  to_node_id varchar(128) NOT NULL,
  relation varchar(48) NOT NULL,
  risk_labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_hmac varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (
    tenant_id, application_id, session_id,
    from_node_type, from_node_id, to_node_type, to_node_id, relation
  )
);

CREATE INDEX IF NOT EXISTS guard_memory_graph_edges_scope_session_idx
  ON guard_memory_graph_edges (tenant_id, application_id, session_id);

CREATE OR REPLACE FUNCTION reject_guard_memory_event_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'guard_memory_events are immutable';
END;
$$;

DROP TRIGGER IF EXISTS guard_memory_events_immutable ON guard_memory_events;
CREATE TRIGGER guard_memory_events_immutable
  BEFORE UPDATE ON guard_memory_events
  FOR EACH ROW EXECUTE FUNCTION reject_guard_memory_event_update();
