SET lock_timeout = '5s';
ALTER TABLE gateway_requests ADD COLUMN IF NOT EXISTS preparation_state varchar(16) NOT NULL DEFAULT 'READY';
CREATE TABLE IF NOT EXISTS gateway_admission_windows (
  tenant_id varchar(36) NOT NULL, application_id varchar(36) NOT NULL,
  window_start timestamptz NOT NULL, admitted integer NOT NULL CHECK (admitted >= 0),
  PRIMARY KEY (tenant_id, application_id, window_start),
  FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS gateway_request_resources (
  tenant_id varchar(36) NOT NULL, application_id varchar(36) NOT NULL, request_id varchar(128) PRIMARY KEY,
  admission jsonb NOT NULL, admission_hmac varchar(64) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED','SETTLED','UNKNOWN')),
  prepared_input_chars integer, inspected_chars integer NOT NULL DEFAULT 0,
  inspection_steps integer NOT NULL DEFAULT 0, prepared_references integer,
  settlement jsonb, settlement_hmac varchar(64), settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, application_id, request_id) REFERENCES gateway_requests(tenant_id,application_id,id) ON DELETE RESTRICT,
  CHECK (prepared_input_chars >= 0 AND inspected_chars >= 0 AND inspection_steps >= 0 AND prepared_references >= 0),
  CHECK ((state = 'RESERVED' AND settlement IS NULL AND settlement_hmac IS NULL AND settled_at IS NULL)
    OR (state <> 'RESERVED' AND settlement IS NOT NULL AND settlement_hmac IS NOT NULL AND settled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS gateway_request_resources_scope_idx ON gateway_request_resources(tenant_id, application_id, created_at);
CREATE OR REPLACE FUNCTION gateway_resource_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'resource evidence cannot be deleted'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.application_id IS DISTINCT FROM OLD.application_id
    OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.admission IS DISTINCT FROM OLD.admission
    OR NEW.admission_hmac IS DISTINCT FROM OLD.admission_hmac OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.state <> 'RESERVED' THEN RAISE EXCEPTION 'resource evidence is immutable'; END IF;
  IF NEW.inspected_chars < OLD.inspected_chars OR NEW.inspection_steps < OLD.inspection_steps THEN RAISE EXCEPTION 'resource measurements cannot decrease'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS gateway_resource_immutable_trigger ON gateway_request_resources;
CREATE TRIGGER gateway_resource_immutable_trigger BEFORE UPDATE OR DELETE ON gateway_request_resources FOR EACH ROW EXECUTE FUNCTION gateway_resource_immutable();
RESET lock_timeout;
