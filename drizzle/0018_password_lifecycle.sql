CREATE TABLE IF NOT EXISTS password_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_history_user_created_idx
  ON password_history (user_id, created_at DESC);

COMMENT ON TABLE password_history IS
  'Bounded password history used to reject reuse; values are one-way bcrypt hashes';
