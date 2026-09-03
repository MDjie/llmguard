ALTER TABLE tool_registry
  ADD COLUMN IF NOT EXISTS side_effect varchar(32) NOT NULL DEFAULT 'READ',
  ADD COLUMN IF NOT EXISTS required_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS allowed_data_destinations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS definition_digest varchar(64);

ALTER TABLE tool_invocations
  ADD COLUMN IF NOT EXISTS agent_run_id varchar(128),
  ADD COLUMN IF NOT EXISTS tool_version varchar(64),
  ADD COLUMN IF NOT EXISTS action_intent_hash varchar(64),
  ADD COLUMN IF NOT EXISTS action_intent jsonb,
  ADD COLUMN IF NOT EXISTS side_effect varchar(32),
  ADD COLUMN IF NOT EXISTS risk_cost integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS risk_budget integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS supporting_envelope_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS data_destinations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS repair_suggestion jsonb,
  ADD COLUMN IF NOT EXISTS approval_decision_id varchar(36),
  ADD COLUMN IF NOT EXISTS permit_consumed_at timestamptz;

CREATE TABLE IF NOT EXISTS agent_lifecycle_budgets (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id varchar(128) NOT NULL,
  principal_id varchar(100) NOT NULL,
  allocated_risk_budget integer NOT NULL CHECK (allocated_risk_budget BETWEEN 0 AND 10000),
  consumed_risk_budget integer NOT NULL DEFAULT 0 CHECK (consumed_risk_budget >= 0),
  tool_steps integer NOT NULL DEFAULT 0 CHECK (tool_steps >= 0),
  maximum_tool_steps integer NOT NULL DEFAULT 32 CHECK (maximum_tool_steps BETWEEN 1 AND 1000),
  state varchar(24) NOT NULL DEFAULT 'ACTIVE',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, application_id, agent_run_id)
);

CREATE INDEX IF NOT EXISTS agent_lifecycle_budgets_expires_idx
  ON agent_lifecycle_budgets (expires_at);

ALTER TABLE tool_registry DROP CONSTRAINT IF EXISTS tool_registry_side_effect_ck;
ALTER TABLE tool_registry ADD CONSTRAINT tool_registry_side_effect_ck CHECK (
  side_effect IN ('NONE','READ','WRITE','EXECUTE','EXTERNAL_COMMUNICATION','FINANCIAL','PRIVILEGE_CHANGE')
);
