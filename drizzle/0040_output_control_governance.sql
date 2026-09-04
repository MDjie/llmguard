BEGIN;

ALTER TABLE response_templates
  ADD COLUMN IF NOT EXISTS jurisdiction varchar(128) NOT NULL DEFAULT 'global',
  ADD COLUMN IF NOT EXISTS business_line varchar(128) NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS legal_disclaimer_version varchar(128) NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS template_scope varchar(32) NOT NULL DEFAULT 'TENANT';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'response_templates_scope_check'
  ) THEN
    ALTER TABLE response_templates
      ADD CONSTRAINT response_templates_scope_check
      CHECK (template_scope IN ('PLATFORM', 'TENANT'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS response_templates_runtime_selector_idx
  ON response_templates (
    tenant_id,
    application_id,
    action,
    locale,
    industry,
    jurisdiction,
    business_line,
    enabled
  );

COMMIT;
