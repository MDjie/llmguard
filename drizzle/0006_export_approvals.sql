CREATE TABLE IF NOT EXISTS export_approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id varchar(100) NOT NULL,
  approver_id varchar(100),
  status varchar(16) NOT NULL DEFAULT 'pending',
  purpose varchar(500) NOT NULL,
  query_hash varchar(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS export_approval_requests_status_idx
  ON export_approval_requests (status);
CREATE INDEX IF NOT EXISTS export_approval_requests_requester_id_idx
  ON export_approval_requests (requester_id);
CREATE INDEX IF NOT EXISTS export_approval_requests_expires_at_idx
  ON export_approval_requests (expires_at);
