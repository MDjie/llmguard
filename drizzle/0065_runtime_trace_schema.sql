-- Additive upgrade. Preserve historical payloads and unknown outcomes without inventing associations.
ALTER TABLE agent_traces
  ADD COLUMN IF NOT EXISTS record_id varchar(36) REFERENCES detection_records(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS provider_id varchar(36) REFERENCES llm_providers(id),
  ADD COLUMN IF NOT EXISTS workflow_name varchar(100),
  ADD COLUMN IF NOT EXISTS request_payload jsonb,
  ADD COLUMN IF NOT EXISTS response_payload jsonb,
  ADD COLUMN IF NOT EXISTS latency_ms integer,
  ADD COLUMN IF NOT EXISTS success boolean,
  ADD COLUMN IF NOT EXISTS error_message text;
-- Legacy session_id is not a detection record ID. Keep it intact and optional for new writers.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='agent_traces' AND column_name='session_id') THEN
    ALTER TABLE agent_traces ALTER COLUMN session_id DROP NOT NULL;
    ALTER TABLE agent_traces ALTER COLUMN trace_type DROP NOT NULL;
    ALTER TABLE agent_traces ALTER COLUMN trace_data DROP NOT NULL;
  END IF;
END $$;
ALTER TABLE agent_traces ALTER COLUMN success DROP NOT NULL;
COMMENT ON COLUMN agent_traces.success IS 'NULL = legacy outcome unknown; new executions explicitly record true or false';
CREATE INDEX IF NOT EXISTS agent_traces_record_id_idx ON agent_traces(record_id);
CREATE INDEX IF NOT EXISTS agent_traces_provider_id_idx ON agent_traces(provider_id);
CREATE INDEX IF NOT EXISTS agent_traces_created_at_idx ON agent_traces(created_at);
ALTER TABLE judge_model_invocations
  ADD COLUMN IF NOT EXISTS input_hash varchar(64),
  ADD COLUMN IF NOT EXISTS prompt_tokens integer,
  ADD COLUMN IF NOT EXISTS completion_tokens integer,
  ADD COLUMN IF NOT EXISTS total_tokens integer;
