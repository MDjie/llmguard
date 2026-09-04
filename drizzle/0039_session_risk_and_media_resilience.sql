DO $$
BEGIN
  IF to_regclass('public.guard_memory_risk_ledgers') IS NOT NULL THEN
    ALTER TABLE guard_memory_risk_ledgers
      DROP CONSTRAINT IF EXISTS guard_memory_risk_ledgers_state_check;

    UPDATE guard_memory_risk_ledgers
    SET risk_state = CASE risk_state
      WHEN 'ELEVATED' THEN 'WATCH'
      WHEN 'RESTRICTED' THEN 'ESCALATED'
      WHEN 'REVIEW_REQUIRED' THEN 'ESCALATED'
      WHEN 'BLOCKED' THEN 'LOCKED'
      ELSE risk_state
    END
    WHERE risk_state IN ('ELEVATED', 'RESTRICTED', 'REVIEW_REQUIRED', 'BLOCKED');

    ALTER TABLE guard_memory_risk_ledgers
      ADD COLUMN IF NOT EXISTS intent_nodes jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS state_transitions jsonb NOT NULL DEFAULT '[]'::jsonb;

    ALTER TABLE guard_memory_risk_ledgers
      ADD CONSTRAINT guard_memory_risk_ledgers_state_check
      CHECK (risk_state IN ('NORMAL', 'WATCH', 'ESCALATED', 'LOCKED'));
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'guard_memory_risk_ledgers_intent_nodes_array_check'
    ) THEN
      ALTER TABLE guard_memory_risk_ledgers
        ADD CONSTRAINT guard_memory_risk_ledgers_intent_nodes_array_check
        CHECK (jsonb_typeof(intent_nodes) = 'array');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'guard_memory_risk_ledgers_state_transitions_array_check'
    ) THEN
      ALTER TABLE guard_memory_risk_ledgers
        ADD CONSTRAINT guard_memory_risk_ledgers_state_transitions_array_check
        CHECK (jsonb_typeof(state_transitions) = 'array');
    END IF;
  END IF;
END $$;

ALTER TABLE IF EXISTS agent_lifecycle_budgets
  ADD COLUMN IF NOT EXISTS media_frames integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS maximum_media_frames integer NOT NULL DEFAULT 10000,
  ADD COLUMN IF NOT EXISTS decoding_branches integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS maximum_decoding_branches integer NOT NULL DEFAULT 64,
  ADD COLUMN IF NOT EXISTS judge_calls integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS maximum_judge_calls integer NOT NULL DEFAULT 32,
  ADD COLUMN IF NOT EXISTS decompressed_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS maximum_decompressed_bytes bigint NOT NULL DEFAULT 1073741824;

DO $$
BEGIN
  IF to_regclass('public.agent_lifecycle_budgets') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_lifecycle_budgets_p3_nonnegative_check'
  ) THEN
    ALTER TABLE agent_lifecycle_budgets
      ADD CONSTRAINT agent_lifecycle_budgets_p3_nonnegative_check CHECK (
        media_frames >= 0 AND maximum_media_frames >= 0 AND
        decoding_branches >= 0 AND maximum_decoding_branches >= 0 AND
        judge_calls >= 0 AND maximum_judge_calls >= 0 AND
        decompressed_bytes >= 0 AND maximum_decompressed_bytes >= 0
      );
  END IF;
END $$;
