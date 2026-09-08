CREATE TABLE IF NOT EXISTS runtime_worker_heartbeats (
  deployment_id varchar(128) NOT NULL, instance_id varchar(64) NOT NULL,
  kind varchar(64) NOT NULL, state varchar(16) NOT NULL, heartbeat_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_worker_heartbeats_identity ON runtime_worker_heartbeats(deployment_id, instance_id);
