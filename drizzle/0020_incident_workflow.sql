CREATE TABLE IF NOT EXISTS security_incidents (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_number varchar(64) NOT NULL,
  title varchar(200) NOT NULL,
  severity varchar(16) NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status varchar(24) NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('PENDING_REVIEW','IN_PROGRESS','FALSE_POSITIVE','BLOCKED','REMEDIATED','CLOSED')),
  trace_id varchar(128), session_id varchar(128), risk_type varchar(128) NOT NULL,
  event_analysis text NOT NULL, attack_technique text NOT NULL, impact text NOT NULL, answer_evidence text NOT NULL,
  assignee_id varchar(100), sla_due_at timestamptz NOT NULL, resolution text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_by varchar(100) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
  UNIQUE (tenant_id, application_id, incident_number)
);
CREATE INDEX IF NOT EXISTS security_incidents_status_sla_idx ON security_incidents (status, sla_due_at);
CREATE INDEX IF NOT EXISTS security_incidents_trace_id_idx ON security_incidents (trace_id);

CREATE TABLE IF NOT EXISTS incident_transitions (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES security_incidents(id) ON DELETE RESTRICT,
  from_status varchar(24), to_status varchar(24) NOT NULL,
  actor_id varchar(100) NOT NULL, assignee_id varchar(100), note text,
  version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, version)
);
CREATE INDEX IF NOT EXISTS incident_transitions_created_at_idx ON incident_transitions (created_at);

CREATE OR REPLACE FUNCTION guardllm_reject_incident_transition_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'incident_transitions is append-only'; END; $$;
DROP TRIGGER IF EXISTS incident_transitions_append_only ON incident_transitions;
CREATE TRIGGER incident_transitions_append_only BEFORE UPDATE OR DELETE ON incident_transitions
FOR EACH ROW EXECUTE FUNCTION guardllm_reject_incident_transition_mutation();
