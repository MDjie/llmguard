ALTER TABLE "tool_registry"
  ADD COLUMN IF NOT EXISTS "source_uri" varchar(2048),
  ADD COLUMN IF NOT EXISTS "source_digest" varchar(71),
  ADD COLUMN IF NOT EXISTS "signature_key_id" varchar(128),
  ADD COLUMN IF NOT EXISTS "signature" text,
  ADD COLUMN IF NOT EXISTS "license_spdx" varchar(128),
  ADD COLUMN IF NOT EXISTS "notice_digest" varchar(71),
  ADD COLUMN IF NOT EXISTS "scanner_definition_digest" varchar(71),
  ADD COLUMN IF NOT EXISTS "network_domains" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "file_paths" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "commands" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "credential_refs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "approval_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "isolated_dynamic_analysis" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "tool_registry_source_digest_idx" ON "tool_registry" ("source_digest");

UPDATE "tool_registry" SET "status" = 'pending_admission'
WHERE "source_digest" IS NULL OR "signature" IS NULL OR jsonb_array_length("approval_ids") < 2;
