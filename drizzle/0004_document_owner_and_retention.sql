ALTER TABLE document_scan_tasks
  ADD COLUMN IF NOT EXISTS owner_id varchar(100),
  ADD COLUMN IF NOT EXISTS content_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS document_scan_tasks_owner_id_idx
  ON document_scan_tasks (owner_id);

UPDATE document_scan_tasks
SET content_expires_at = COALESCE(content_expires_at, created_at + interval '7 days')
WHERE content_expires_at IS NULL;

-- Existing rows have no trustworthy owner. Keep owner_id NULL so ordinary users
-- cannot acquire them; an authorized migration job must assign ownership.
