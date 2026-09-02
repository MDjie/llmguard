BEGIN;

CREATE TABLE IF NOT EXISTS application_routing_configs (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id varchar(36) NOT NULL,
  application_id varchar(36) NOT NULL,
  mode varchar(20) NOT NULL DEFAULT 'legacy',
  guard_percent integer NOT NULL DEFAULT 0,
  generation integer NOT NULL DEFAULT 0,
  previous_config jsonb,
  updated_by varchar(100) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT application_routing_configs_scope_fk
    FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT application_routing_configs_scope_uq UNIQUE (tenant_id, application_id),
  CONSTRAINT application_routing_configs_mode_ck
    CHECK (mode IN ('legacy', 'shadow', 'canary', 'enforcing')),
  CONSTRAINT application_routing_configs_percent_ck
    CHECK (guard_percent IN (0, 1, 5, 25, 100)),
  CONSTRAINT application_routing_configs_mode_percent_ck CHECK (
    (mode = 'legacy' AND guard_percent = 0) OR
    (mode = 'shadow' AND guard_percent = 0) OR
    (mode = 'canary' AND guard_percent IN (1, 5, 25, 100)) OR
    (mode = 'enforcing' AND guard_percent = 100)
  )
);

COMMIT;
