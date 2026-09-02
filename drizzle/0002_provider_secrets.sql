BEGIN;

CREATE TABLE IF NOT EXISTS secret_envelopes (
  ref VARCHAR(80) PRIMARY KEY,
  key_id VARCHAR(100) NOT NULL,
  algorithm VARCHAR(30) NOT NULL DEFAULT 'AES-256-GCM',
  iv VARCHAR(32) NOT NULL,
  ciphertext TEXT NOT NULL,
  auth_tag VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS secret_envelopes_key_id_idx ON secret_envelopes(key_id);

ALTER TABLE llm_providers
  ADD COLUMN IF NOT EXISTS secret_ref VARCHAR(80) REFERENCES secret_envelopes(ref) ON DELETE SET NULL;

COMMIT;
