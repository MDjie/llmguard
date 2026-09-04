ALTER TABLE "agent_lifecycle_budgets"
  ADD COLUMN IF NOT EXISTS "recursion_depth" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maximum_recursion_depth" integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS "browser_tabs" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maximum_browser_tabs" integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS "processes" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maximum_processes" integer NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS "connections" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maximum_connections" integer NOT NULL DEFAULT 16,
  ADD COLUMN IF NOT EXISTS "files" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maximum_files" integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "ocr_pages" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maximum_ocr_pages" integer NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS "media_duration_seconds" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maximum_media_duration_seconds" integer NOT NULL DEFAULT 3600,
  ADD COLUMN IF NOT EXISTS "guard_inference_tokens" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maximum_guard_inference_tokens" integer NOT NULL DEFAULT 1000000;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'agent_lifecycle_budgets_nonnegative_check'
       AND conrelid = 'agent_lifecycle_budgets'::regclass
  ) THEN
    ALTER TABLE "agent_lifecycle_budgets"
      ADD CONSTRAINT "agent_lifecycle_budgets_nonnegative_check" CHECK (
        "allocated_risk_budget" >= 0 AND "consumed_risk_budget" >= 0 AND
        "tool_steps" >= 0 AND "maximum_tool_steps" >= 0 AND
        "recursion_depth" >= 0 AND "maximum_recursion_depth" >= 0 AND
        "browser_tabs" >= 0 AND "maximum_browser_tabs" >= 0 AND
        "processes" >= 0 AND "maximum_processes" >= 0 AND
        "connections" >= 0 AND "maximum_connections" >= 0 AND
        "files" >= 0 AND "maximum_files" >= 0 AND
        "ocr_pages" >= 0 AND "maximum_ocr_pages" >= 0 AND
        "media_duration_seconds" >= 0 AND "maximum_media_duration_seconds" >= 0 AND
        "guard_inference_tokens" >= 0 AND "maximum_guard_inference_tokens" >= 0
      );
  END IF;
END $$;
