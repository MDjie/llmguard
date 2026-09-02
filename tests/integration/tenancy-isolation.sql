\set ON_ERROR_STOP on

BEGIN;

INSERT INTO tenants (id, code, name)
VALUES (
  '10000000-0000-0000-0000-000000000001',
  'isolation-test',
  'Isolation test'
);

INSERT INTO applications (id, tenant_id, code, name)
VALUES (
  '10000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001',
  'default',
  'Test app'
);

-- A tenant may reuse a policy name owned by another tenant/application.
INSERT INTO policy_profiles (id, tenant_id, application_id, name)
VALUES (
  '10000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  '默认策略'
);

DO $assertions$
BEGIN
  BEGIN
    INSERT INTO policy_profiles (id, tenant_id, application_id, name)
    VALUES (
      '10000000-0000-0000-0000-000000000004',
      '10000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000002',
      '默认策略'
    );
    RAISE EXCEPTION 'same-scope duplicate unexpectedly accepted';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO policy_profiles (id, tenant_id, application_id, name)
    VALUES (
      '10000000-0000-0000-0000-000000000005',
      '00000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000002',
      'bad-scope'
    );
    RAISE EXCEPTION 'mismatched tenant/application scope unexpectedly accepted';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;

  IF (
    SELECT count(*)
    FROM policy_profiles
    WHERE name = '默认策略'
      AND tenant_id = '10000000-0000-0000-0000-000000000001'
  ) <> 1 THEN
    RAISE EXCEPTION 'tenant-local duplicate-name assertion failed';
  END IF;
END
$assertions$;

ROLLBACK;
