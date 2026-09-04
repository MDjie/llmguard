CREATE TABLE IF NOT EXISTS dictionary_releases (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dictionary_id varchar(128) NOT NULL,
  version varchar(64) NOT NULL,
  state varchar(32) NOT NULL DEFAULT 'draft',
  canonical_manifest jsonb NOT NULL,
  content_hash varchar(64) NOT NULL,
  signature text NOT NULL,
  signature_algorithm varchar(32) NOT NULL DEFAULT 'Ed25519',
  signing_key_id varchar(128) NOT NULL,
  entry_count integer NOT NULL DEFAULT 0,
  statistics jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_by varchar(100) NOT NULL,
  approved_by varchar(100),
  approved_at timestamptz,
  activated_at timestamptz,
  rolled_back_at timestamptz,
  rollback_of_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dictionary_releases_state_ck CHECK (
    state IN ('draft', 'reviewed', 'shadow', 'canary', 'active', 'deprecated', 'rolled_back')
  ),
  CONSTRAINT dictionary_releases_hash_ck CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT dictionary_releases_signature_algorithm_ck CHECK (signature_algorithm = 'Ed25519'),
  CONSTRAINT dictionary_releases_entry_count_ck CHECK (entry_count >= 0),
  CONSTRAINT dictionary_releases_approval_ck CHECK (
    state NOT IN ('reviewed', 'shadow', 'canary', 'active') OR
    (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS dictionary_releases_scope_dictionary_version_uq
  ON dictionary_releases (tenant_id, application_id, dictionary_id, version);
CREATE INDEX IF NOT EXISTS dictionary_releases_scope_state_idx
  ON dictionary_releases (tenant_id, application_id, state);
CREATE INDEX IF NOT EXISTS dictionary_releases_content_hash_idx
  ON dictionary_releases (content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS dictionary_releases_scope_id_uq
  ON dictionary_releases (tenant_id, application_id, id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dictionary_releases_rollback_fk'
  ) THEN
    ALTER TABLE dictionary_releases
      ADD CONSTRAINT dictionary_releases_rollback_fk
      FOREIGN KEY (rollback_of_id) REFERENCES dictionary_releases(id) ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dictionary_releases_rollback_scope_fk'
  ) THEN
    ALTER TABLE dictionary_releases
      ADD CONSTRAINT dictionary_releases_rollback_scope_fk
      FOREIGN KEY (tenant_id, application_id, rollback_of_id)
      REFERENCES dictionary_releases(tenant_id, application_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS dictionary_release_transitions (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES dictionary_releases(id) ON DELETE RESTRICT,
  from_state varchar(32),
  to_state varchar(32) NOT NULL,
  action varchar(32) NOT NULL,
  actor_id varchar(100) NOT NULL,
  reason varchar(500),
  manifest_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dictionary_release_transitions_hash_ck CHECK (manifest_hash ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS dictionary_release_transitions_release_idx
  ON dictionary_release_transitions (release_id, created_at);
CREATE INDEX IF NOT EXISTS dictionary_release_transitions_scope_idx
  ON dictionary_release_transitions (tenant_id, application_id, created_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dictionary_release_transitions_scope_fk'
  ) THEN
    ALTER TABLE dictionary_release_transitions
      ADD CONSTRAINT dictionary_release_transitions_scope_fk
      FOREIGN KEY (tenant_id, application_id, release_id)
      REFERENCES dictionary_releases(tenant_id, application_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS response_templates (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key varchar(128) NOT NULL,
  risk_category varchar(128) NOT NULL,
  action varchar(32) NOT NULL,
  locale varchar(64) NOT NULL DEFAULT 'zh-CN',
  industry varchar(128) NOT NULL DEFAULT 'general',
  template_text text NOT NULL,
  allowed_variables jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL,
  content_hash varchar(64) NOT NULL,
  signature_digest varchar(64) NOT NULL,
  approval_status varchar(32) NOT NULL DEFAULT 'pending',
  created_by varchar(100) NOT NULL,
  approved_by varchar(100),
  approved_at timestamptz,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT response_templates_action_ck CHECK (
    action IN ('WARN', 'MASK', 'REWRITE', 'REQUIRE_REVIEW', 'SAFE_RESPONSE', 'BLOCK')
  ),
  CONSTRAINT response_templates_approval_status_ck CHECK (
    approval_status IN ('pending', 'approved', 'rejected', 'retired')
  ),
  CONSTRAINT response_templates_hash_ck CHECK (
    content_hash ~ '^[a-f0-9]{64}$' AND signature_digest ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT response_templates_validity_ck CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT response_templates_approval_ck CHECK (
    approval_status <> 'approved' OR
    (approved_by IS NOT NULL AND approved_at IS NOT NULL AND enabled)
  ),
  CONSTRAINT response_templates_variables_ck CHECK (jsonb_typeof(allowed_variables) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS response_templates_scope_key_version_uq
  ON response_templates (tenant_id, application_id, template_key, version);
CREATE INDEX IF NOT EXISTS response_templates_scope_status_idx
  ON response_templates (tenant_id, application_id, approval_status, enabled);

ALTER TABLE IF EXISTS keyword_rules
  ADD COLUMN IF NOT EXISTS release_id uuid REFERENCES dictionary_releases(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS canonical_term varchar(500),
  ADD COLUMN IF NOT EXISTS variant_type varchar(32) NOT NULL DEFAULT 'canonical',
  ADD COLUMN IF NOT EXISTS locale varchar(64) NOT NULL DEFAULT 'und',
  ADD COLUMN IF NOT EXISTS direction varchar(32) NOT NULL DEFAULT 'BOTH',
  ADD COLUMN IF NOT EXISTS industry varchar(128) NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS contexts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS severity varchar(20) NOT NULL DEFAULT 'MEDIUM',
  ADD COLUMN IF NOT EXISTS mandatory_deny boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS valid_from timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS valid_to timestamptz,
  ADD COLUMN IF NOT EXISTS owner varchar(100),
  ADD COLUMN IF NOT EXISTS evidence_requirement varchar(500),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS keyword_rules_release_idx ON keyword_rules (release_id);
CREATE INDEX IF NOT EXISTS keyword_rules_validity_idx ON keyword_rules (valid_from, valid_to);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'keyword_rules_release_scope_fk'
  ) THEN
    ALTER TABLE keyword_rules
      ADD CONSTRAINT keyword_rules_release_scope_fk
      FOREIGN KEY (tenant_id, application_id, release_id)
      REFERENCES dictionary_releases(tenant_id, application_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'keyword_rules_governed_metadata_ck'
  ) THEN
    ALTER TABLE keyword_rules ADD CONSTRAINT keyword_rules_governed_metadata_ck CHECK (
      release_id IS NULL OR (
        canonical_term IS NOT NULL AND length(btrim(canonical_term)) > 0 AND
        owner IS NOT NULL AND length(btrim(owner)) > 0 AND
        evidence_requirement IS NOT NULL AND length(btrim(evidence_requirement)) > 0 AND
        (valid_to IS NULL OR valid_to > valid_from)
      )
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS detector_calibrations (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detector_id varchar(128) NOT NULL,
  detector_version varchar(64) NOT NULL,
  risk_type varchar(128) NOT NULL,
  locale varchar(64) NOT NULL DEFAULT 'und',
  industry varchar(128) NOT NULL DEFAULT 'general',
  threshold numeric(6,5) NOT NULL,
  confidence_floor numeric(6,5) NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  dataset_hash varchar(64) NOT NULL,
  bundle_id varchar(36),
  approved_by varchar(100) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT detector_calibrations_threshold_ck CHECK (
    threshold BETWEEN 0 AND 1 AND confidence_floor BETWEEN 0 AND 1
  ),
  CONSTRAINT detector_calibrations_dataset_hash_ck CHECK (dataset_hash ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS detector_calibrations_scope_identity_uq
  ON detector_calibrations (
    tenant_id, application_id, detector_id, detector_version, risk_type, locale, industry
  );
CREATE INDEX IF NOT EXISTS detector_calibrations_scope_detector_idx
  ON detector_calibrations (tenant_id, application_id, detector_id);

CREATE TABLE IF NOT EXISTS badcase_feedback (
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id varchar(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_hash varchar(64) NOT NULL,
  decision_id varchar(128),
  risk_type varchar(128) NOT NULL,
  predicted_action varchar(32) NOT NULL,
  expected_action varchar(32) NOT NULL,
  evidence_hmacs jsonb NOT NULL DEFAULT '[]'::jsonb,
  classification varchar(32) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'open',
  reviewer_id varchar(100),
  disposition varchar(500),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT badcase_feedback_request_hash_ck CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT badcase_feedback_classification_ck CHECK (
    classification IN ('false_positive', 'false_negative', 'wrong_action', 'wrong_explanation')
  ),
  CONSTRAINT badcase_feedback_status_ck CHECK (status IN ('open', 'triaged', 'resolved', 'rejected')),
  CONSTRAINT badcase_feedback_evidence_ck CHECK (jsonb_typeof(evidence_hmacs) = 'array')
);

CREATE INDEX IF NOT EXISTS badcase_feedback_scope_status_idx
  ON badcase_feedback (tenant_id, application_id, status);
CREATE INDEX IF NOT EXISTS badcase_feedback_request_hash_idx
  ON badcase_feedback (request_hash);

DO $$
DECLARE
  scoped_table text;
BEGIN
  FOREACH scoped_table IN ARRAY ARRAY[
    'dictionary_releases',
    'dictionary_release_transitions',
    'response_templates',
    'detector_calibrations',
    'badcase_feedback'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conname = scoped_table || '_application_scope_fk'
         AND conrelid = to_regclass(scoped_table)
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id) ON DELETE RESTRICT',
        scoped_table,
        scoped_table || '_application_scope_fk'
      );
    END IF;
  END LOOP;
END $$;

ALTER TABLE IF EXISTS whitelist_rules
  ADD COLUMN IF NOT EXISTS valid_from timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS approval_status varchar(32) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS approved_by varchar(100),
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

CREATE INDEX IF NOT EXISTS whitelist_rules_approval_idx
  ON whitelist_rules (approval_status, valid_from);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whitelist_rules_approved_scope_ck'
  ) THEN
    ALTER TABLE whitelist_rules ADD CONSTRAINT whitelist_rules_approved_scope_ck CHECK (
      approval_status <> 'approved' OR (
        approved_by IS NOT NULL AND approved_at IS NOT NULL AND
        dimension_scope = 'specific' AND jsonb_array_length(dimension_codes) > 0 AND
        jsonb_array_length(target_rule_ids) > 0 AND jsonb_array_length(directions) > 0 AND
        expires_at IS NOT NULL AND expires_at > valid_from
      )
    );
  END IF;
END $$;

ALTER TABLE IF EXISTS guard_session_risk_states
  ADD COLUMN IF NOT EXISTS risk_vector jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS recent_risk_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS escalation_level integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_request_id varchar(128);

CREATE OR REPLACE FUNCTION guard_dictionary_release_immutable_content()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dictionary releases are append-only';
  END IF;
  IF ROW(
    OLD.tenant_id, OLD.application_id, OLD.dictionary_id, OLD.version,
    OLD.canonical_manifest, OLD.content_hash, OLD.signature,
    OLD.signature_algorithm, OLD.signing_key_id, OLD.entry_count
  ) IS DISTINCT FROM ROW(
    NEW.tenant_id, NEW.application_id, NEW.dictionary_id, NEW.version,
    NEW.canonical_manifest, NEW.content_hash, NEW.signature,
    NEW.signature_algorithm, NEW.signing_key_id, NEW.entry_count
  ) THEN
    RAISE EXCEPTION 'dictionary release content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'dictionary_releases_immutable_content') THEN
    CREATE TRIGGER dictionary_releases_immutable_content
      BEFORE UPDATE OR DELETE ON dictionary_releases
      FOR EACH ROW EXECUTE FUNCTION guard_dictionary_release_immutable_content();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION guard_response_template_immutable_after_approval()
RETURNS trigger AS $$
BEGIN
  IF OLD.approval_status = 'approved' AND ROW(
    OLD.template_key, OLD.risk_category, OLD.action, OLD.locale, OLD.industry,
    OLD.template_text, OLD.allowed_variables, OLD.version, OLD.content_hash, OLD.signature_digest
  ) IS DISTINCT FROM ROW(
    NEW.template_key, NEW.risk_category, NEW.action, NEW.locale, NEW.industry,
    NEW.template_text, NEW.allowed_variables, NEW.version, NEW.content_hash, NEW.signature_digest
  ) THEN
    RAISE EXCEPTION 'approved response template content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'response_templates_immutable_after_approval') THEN
    CREATE TRIGGER response_templates_immutable_after_approval
      BEFORE UPDATE ON response_templates
      FOR EACH ROW EXECUTE FUNCTION guard_response_template_immutable_after_approval();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION guard_dictionary_transition_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'dictionary release transitions are append-only';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'dictionary_release_transitions_append_only') THEN
    CREATE TRIGGER dictionary_release_transitions_append_only
      BEFORE UPDATE OR DELETE ON dictionary_release_transitions
      FOR EACH ROW EXECUTE FUNCTION guard_dictionary_transition_append_only();
  END IF;
END $$;
