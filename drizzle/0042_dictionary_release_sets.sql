BEGIN;

CREATE TABLE IF NOT EXISTS dictionary_release_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar(36) NOT NULL, application_id varchar(36) NOT NULL,
  policy_id varchar(36) NOT NULL, dictionary_id varchar(128) NOT NULL, version varchar(64) NOT NULL,
  state varchar(32) NOT NULL DEFAULT 'draft', revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  canonical_manifest jsonb NOT NULL, content_hash varchar(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  signature text NOT NULL, signing_key_id varchar(128) NOT NULL, shard_count integer NOT NULL CHECK (shard_count > 0),
  submitted_by varchar(100) NOT NULL, approved_by varchar(100), approved_at timestamptz,
  previous_set_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dictionary_release_sets_scope_id_uq UNIQUE (tenant_id, application_id, id),
  CONSTRAINT dictionary_release_sets_scope_version_uq UNIQUE (tenant_id, application_id, dictionary_id, version),
  CONSTRAINT dictionary_release_sets_policy_scope_fk FOREIGN KEY (tenant_id, application_id, policy_id)
    REFERENCES policy_profiles(tenant_id, application_id, id) ON DELETE RESTRICT,
  CONSTRAINT dictionary_release_sets_previous_scope_fk FOREIGN KEY (tenant_id, application_id, previous_set_id)
    REFERENCES dictionary_release_sets(tenant_id, application_id, id) ON DELETE RESTRICT,
  CONSTRAINT dictionary_release_sets_state_ck CHECK (state IN ('draft','reviewed','shadow','canary','active','deprecated','rolled_back')),
  CONSTRAINT dictionary_release_sets_approval_ck CHECK (state = 'draft' OR
    (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_by <> submitted_by))
);
CREATE UNIQUE INDEX IF NOT EXISTS dictionary_release_sets_one_active_uq
  ON dictionary_release_sets(tenant_id, application_id, dictionary_id) WHERE state = 'active';
ALTER TABLE dictionary_releases ADD COLUMN IF NOT EXISTS release_set_id uuid;
ALTER TABLE dictionary_releases ADD COLUMN IF NOT EXISTS part_number integer;
CREATE UNIQUE INDEX IF NOT EXISTS dictionary_releases_set_part_uq ON dictionary_releases(release_set_id, part_number);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dictionary_releases_set_scope_fk') THEN
    ALTER TABLE dictionary_releases ADD CONSTRAINT dictionary_releases_set_scope_fk
      FOREIGN KEY (tenant_id, application_id, release_set_id)
      REFERENCES dictionary_release_sets(tenant_id, application_id, id) ON DELETE RESTRICT;
    ALTER TABLE dictionary_releases ADD CONSTRAINT dictionary_releases_set_part_ck
      CHECK ((release_set_id IS NULL AND part_number IS NULL) OR (release_set_id IS NOT NULL AND part_number IS NOT NULL AND part_number > 0));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION guard_dictionary_set_identity() RETURNS trigger AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'dictionary release sets are append-preserved'; END IF;
  IF ROW(OLD.id,OLD.tenant_id,OLD.application_id,OLD.policy_id,OLD.dictionary_id,OLD.version,
    OLD.canonical_manifest,OLD.content_hash,OLD.signature,OLD.signing_key_id,OLD.shard_count,OLD.submitted_by,OLD.created_at)
    IS DISTINCT FROM ROW(NEW.id,NEW.tenant_id,NEW.application_id,NEW.policy_id,NEW.dictionary_id,NEW.version,
    NEW.canonical_manifest,NEW.content_hash,NEW.signature,NEW.signing_key_id,NEW.shard_count,NEW.submitted_by,NEW.created_at)
  THEN RAISE EXCEPTION 'dictionary release set identity is immutable'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION guard_dictionary_set_membership() RETURNS trigger AS $$ BEGIN
  IF ROW(OLD.release_set_id,OLD.part_number) IS DISTINCT FROM ROW(NEW.release_set_id,NEW.part_number)
  THEN RAISE EXCEPTION 'dictionary release set membership is immutable'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Deferred until COMMIT: no partial imports or mixed shard states, including direct SQL callers.
CREATE OR REPLACE FUNCTION guard_dictionary_set_complete() RETURNS trigger AS $$
DECLARE root_id uuid; root dictionary_release_sets%ROWTYPE; actual_count integer;
BEGIN
  IF TG_TABLE_NAME='dictionary_release_sets' THEN root_id:=NEW.id; ELSE root_id:=NEW.release_set_id; END IF;
  IF root_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO root FROM dictionary_release_sets WHERE id=root_id;
  SELECT count(*) INTO actual_count FROM dictionary_releases WHERE release_set_id=root_id;
  IF actual_count<>root.shard_count OR root.shard_count<>jsonb_array_length(root.canonical_manifest->'shards') OR EXISTS (
    SELECT 1 FROM dictionary_releases d WHERE d.release_set_id=root_id AND (
      d.state<>root.state OR d.approved_by IS DISTINCT FROM root.approved_by OR d.submitted_by<>root.submitted_by OR
      d.part_number>root.shard_count OR d.content_hash IS DISTINCT FROM root.canonical_manifest->'shards'->(d.part_number-1)->>'sha256' OR
      d.canonical_manifest IS DISTINCT FROM root.canonical_manifest->'shards'->(d.part_number-1)->'manifest'
    )
  ) THEN RAISE EXCEPTION 'dictionary release set incomplete or mixed'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='dictionary_sets_identity') THEN
    CREATE TRIGGER dictionary_sets_identity BEFORE UPDATE OR DELETE ON dictionary_release_sets
      FOR EACH ROW EXECUTE FUNCTION guard_dictionary_set_identity();
    CREATE TRIGGER dictionary_sets_membership BEFORE UPDATE ON dictionary_releases
      FOR EACH ROW EXECUTE FUNCTION guard_dictionary_set_membership();
    CREATE CONSTRAINT TRIGGER dictionary_sets_complete AFTER INSERT OR UPDATE ON dictionary_release_sets
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_dictionary_set_complete();
    CREATE CONSTRAINT TRIGGER dictionary_shards_complete AFTER INSERT OR UPDATE ON dictionary_releases
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_dictionary_set_complete();
  END IF;
END $$;
COMMIT;
