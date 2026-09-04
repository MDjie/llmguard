\set ON_ERROR_STOP on

BEGIN;

INSERT INTO tenants (id, code, name)
VALUES (
  '30000000-0000-0000-0000-000000000001',
  'policy-governance-test',
  'Policy governance test'
);

INSERT INTO applications (id, tenant_id, code, name)
VALUES (
  '30000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000001',
  'default',
  'Policy governance app'
);

INSERT INTO policy_profiles (id, tenant_id, application_id, name)
VALUES (
  '30000000-0000-0000-0000-000000000003',
  '30000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  'Governed policy'
);

INSERT INTO tenants (id, code, name)
VALUES (
  '30000000-0000-0000-0000-000000000010',
  'policy-governance-other-test',
  'Policy governance other tenant'
);

INSERT INTO applications (id, tenant_id, code, name)
VALUES (
  '30000000-0000-0000-0000-000000000011',
  '30000000-0000-0000-0000-000000000010',
  'default',
  'Policy governance other app'
);

INSERT INTO policy_profiles (id, tenant_id, application_id, name)
VALUES (
  '30000000-0000-0000-0000-000000000012',
  '30000000-0000-0000-0000-000000000010',
  '30000000-0000-0000-0000-000000000011',
  'Other governed policy'
);

DO $assertions$
BEGIN
  BEGIN
    INSERT INTO dictionary_releases (
      tenant_id, application_id, dictionary_id, version, state,
      canonical_manifest, content_hash, signature, signing_key_id,
      entry_count, submitted_by
    ) VALUES (
      '30000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000002',
      'content-safety-core', 'invalid-unapproved', 'active',
      '{}'::jsonb, repeat('a', 64), 'unsigned', 'test-key', 1, 'builder-1'
    );
    RAISE EXCEPTION 'unapproved active dictionary release unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO response_templates (
      tenant_id, application_id, template_key, risk_category, action,
      template_text, allowed_variables, version, content_hash,
      signature_digest, approval_status, created_by, enabled
    ) VALUES (
      '30000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000002',
      'invalid-template', 'prompt_injection', 'BLOCK',
      'Safe response', '[]'::jsonb, 1, repeat('a', 64),
      repeat('b', 64), 'approved', 'builder-1', true
    );
    RAISE EXCEPTION 'approved template without approver unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO whitelist_rules (
      tenant_id, application_id, name, policy_scope, dimension_scope,
      dimension_codes, target_rule_ids, directions, valid_from, expires_at,
      approval_status, approved_by, approved_at, pattern, enabled
    ) VALUES (
      '30000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000002',
      'invalid-global', 'all', 'all', '[]'::jsonb, '[]'::jsonb,
      '[]'::jsonb, now(), now() + interval '1 day',
      'approved', 'reviewer-2', now(), 'trusted', true
    );
    RAISE EXCEPTION 'unbounded approved whitelist unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO detector_calibrations (
      tenant_id, application_id, detector_id, detector_version, risk_type,
      threshold, confidence_floor, dataset_hash, approved_by
    ) VALUES (
      '30000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000002',
      'rules', '1.0.0', 'prompt_injection', 1.1, 0.8,
      repeat('d', 64), 'reviewer-2'
    );
    RAISE EXCEPTION 'out-of-range calibration unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$assertions$;

INSERT INTO dictionary_releases (
  tenant_id, application_id, id, dictionary_id, version, state,
  canonical_manifest, content_hash, signature, signing_key_id,
  entry_count, submitted_by, approved_by, approved_at, activated_at
) VALUES (
  '30000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000004',
  'content-safety-core', '1.0.0', 'active',
  '{"schema":"dictionary-manifest/v1"}'::jsonb,
  repeat('a', 64), 'test-signature', 'test-key', 1,
  'builder-1', 'reviewer-2', now(), now()
);

DO $tenant_scope$
BEGIN
  BEGIN
    INSERT INTO dictionary_releases (
      tenant_id, application_id, id, dictionary_id, version, state,
      canonical_manifest, content_hash, signature, signing_key_id,
      entry_count, submitted_by
    ) VALUES (
      '30000000-0000-0000-0000-000000000010',
      '30000000-0000-0000-0000-000000000002',
      '30000000-0000-0000-0000-000000000020',
      'cross-tenant', '1.0.0', 'draft', '{}'::jsonb,
      repeat('1', 64), 'test-signature', 'test-key', 0, 'builder-1'
    );
    RAISE EXCEPTION 'cross-tenant dictionary application scope unexpectedly accepted';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO response_templates (
      tenant_id, application_id, id, template_key, risk_category, action,
      template_text, allowed_variables, version, content_hash,
      signature_digest, approval_status, created_by, enabled
    ) VALUES (
      '30000000-0000-0000-0000-000000000010',
      '30000000-0000-0000-0000-000000000002',
      '30000000-0000-0000-0000-000000000021',
      'cross-tenant', 'prompt_injection', 'BLOCK', 'Safe response',
      '[]'::jsonb, 1, repeat('2', 64), repeat('3', 64),
      'pending', 'builder-1', false
    );
    RAISE EXCEPTION 'cross-tenant response template application scope unexpectedly accepted';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO detector_calibrations (
      tenant_id, application_id, detector_id, detector_version, risk_type,
      threshold, confidence_floor, dataset_hash, approved_by
    ) VALUES (
      '30000000-0000-0000-0000-000000000010',
      '30000000-0000-0000-0000-000000000002',
      'cross-tenant-detector', '1.0.0', 'prompt_injection',
      0.8, 0.7, repeat('4', 64), 'reviewer-2'
    );
    RAISE EXCEPTION 'cross-tenant detector calibration application scope unexpectedly accepted';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO badcase_feedback (
      tenant_id, application_id, request_hash, risk_type,
      predicted_action, expected_action, evidence_hmacs, classification
    ) VALUES (
      '30000000-0000-0000-0000-000000000010',
      '30000000-0000-0000-0000-000000000002',
      repeat('5', 64), 'prompt_injection', 'ALLOW', 'BLOCK',
      '[]'::jsonb, 'false_negative'
    );
    RAISE EXCEPTION 'cross-tenant badcase application scope unexpectedly accepted';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO dictionary_release_transitions (
      tenant_id, application_id, id, release_id, from_state, to_state,
      action, actor_id, manifest_hash
    ) VALUES (
      '30000000-0000-0000-0000-000000000010',
      '30000000-0000-0000-0000-000000000011',
      '30000000-0000-0000-0000-000000000022',
      '30000000-0000-0000-0000-000000000004',
      'canary', 'active', 'activate', 'reviewer-2', repeat('6', 64)
    );
    RAISE EXCEPTION 'cross-tenant dictionary transition unexpectedly accepted';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO keyword_rules (
      tenant_id, application_id, policy_id, release_id, dimension, keyword,
      canonical_term, owner, evidence_requirement, valid_from, valid_to
    ) VALUES (
      '30000000-0000-0000-0000-000000000010',
      '30000000-0000-0000-0000-000000000011',
      '30000000-0000-0000-0000-000000000012',
      '30000000-0000-0000-0000-000000000004',
      'prompt_injection', 'cross tenant', 'cross tenant',
      'platform-security', 'negative-test', now(), now() + interval '1 day'
    );
    RAISE EXCEPTION 'cross-tenant governed keyword release unexpectedly accepted';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO content_access_requests (
      tenant_id, application_id, resource_type, resource_id, source_digest,
      requester_id, purpose, reason
    ) VALUES (
      '30000000-0000-0000-0000-000000000010',
      '30000000-0000-0000-0000-000000000002',
      'INCIDENT_EVIDENCE', 'incident-cross-tenant', repeat('8', 64),
      'requester-1', 'INCIDENT_INVESTIGATION', 'Cross-tenant negative test'
    );
    RAISE EXCEPTION 'cross-tenant content access request unexpectedly accepted';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO dictionary_releases (
      tenant_id, application_id, id, dictionary_id, version, state,
      canonical_manifest, content_hash, signature, signing_key_id,
      entry_count, submitted_by, rollback_of_id
    ) VALUES (
      '30000000-0000-0000-0000-000000000010',
      '30000000-0000-0000-0000-000000000011',
      '30000000-0000-0000-0000-000000000023',
      'rollback-cross-tenant', '1.0.0', 'rolled_back', '{}'::jsonb,
      repeat('7', 64), 'test-signature', 'test-key', 0, 'builder-1',
      '30000000-0000-0000-0000-000000000004'
    );
    RAISE EXCEPTION 'cross-tenant dictionary rollback reference unexpectedly accepted';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;
END
$tenant_scope$;

INSERT INTO dictionary_release_transitions (
  tenant_id, application_id, id, release_id, from_state, to_state,
  action, actor_id, manifest_hash
) VALUES (
  '30000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000005',
  '30000000-0000-0000-0000-000000000004',
  'canary', 'active', 'activate', 'reviewer-2', repeat('c', 64)
);

INSERT INTO response_templates (
  tenant_id, application_id, id, template_key, risk_category, action,
  template_text, allowed_variables, version, content_hash,
  signature_digest, approval_status, created_by, approved_by,
  approved_at, enabled
) VALUES (
  '30000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000006',
  'platform.block.prompt-injection', 'prompt_injection', 'BLOCK',
  'This request cannot be completed safely.', '[]'::jsonb, 1,
  repeat('d', 64), repeat('e', 64), 'approved', 'builder-1',
  'reviewer-2', now(), true
);

INSERT INTO whitelist_rules (
  tenant_id, application_id, id, name, policy_scope, dimension_scope,
  dimension_codes, target_rule_ids, directions, valid_from, expires_at,
  approval_status, approved_by, approved_at, pattern, enabled
) VALUES (
  '30000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000007',
  'bounded-example', 'all', 'specific', '["prompt_injection"]'::jsonb,
  '["rule-1"]'::jsonb, '["INPUT"]'::jsonb,
  now(), now() + interval '1 day', 'approved', 'reviewer-2', now(),
  'approved example', true
);

INSERT INTO keyword_rules (
  tenant_id, application_id, policy_id, release_id, dimension, keyword,
  canonical_term, owner, evidence_requirement, valid_from, valid_to
) VALUES (
  '30000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000003',
  '30000000-0000-0000-0000-000000000004',
  'prompt_injection', 'ignore previous instructions',
  'ignore previous instructions', 'platform-security',
  'approved-positive-and-negative-examples', now(), now() + interval '1 day'
);

INSERT INTO badcase_feedback (
  tenant_id, application_id, request_hash, risk_type, predicted_action,
  expected_action, evidence_hmacs, classification
) VALUES (
  '30000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  repeat('f', 64), 'prompt_injection', 'ALLOW', 'BLOCK',
  '["evidence-hmac"]'::jsonb, 'false_negative'
);

INSERT INTO content_access_requests (
  tenant_id, application_id, id, resource_type, resource_id, source_digest,
  requester_id, purpose, reason
) VALUES (
  '30000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000008',
  'INCIDENT_EVIDENCE', 'incident-governance-test', repeat('9', 64),
  'requester-1', 'INCIDENT_INVESTIGATION', 'Verify one-time governed evidence access'
);

DO $p5_governance$
BEGIN
  BEGIN
    INSERT INTO dictionary_releases (
      tenant_id, application_id, id, dictionary_id, version, state,
      canonical_manifest, content_hash, signature, signing_key_id,
      entry_count, submitted_by, approved_by, approved_at, activated_at
    ) VALUES (
      '30000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000002',
      '30000000-0000-0000-0000-000000000024',
      'content-safety-core', '2.0.0', 'active', '{}'::jsonb,
      repeat('1', 64), 'test-signature', 'test-key', 0,
      'builder-1', 'reviewer-2', now(), now()
    );
    RAISE EXCEPTION 'second active dictionary unexpectedly accepted';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO response_templates (
      tenant_id, application_id, id, template_key, risk_category, action,
      template_text, allowed_variables, version, content_hash,
      signature_digest, approval_status, created_by, approved_by,
      approved_at, enabled
    ) VALUES (
      '30000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000002',
      '30000000-0000-0000-0000-000000000025',
      'tenant.block.prompt-injection', 'prompt_injection', 'BLOCK',
      'A conflicting runtime selector.', '[]'::jsonb, 1,
      repeat('2', 64), repeat('3', 64), 'approved', 'builder-1',
      'reviewer-2', now(), true
    );
    RAISE EXCEPTION 'conflicting active response-template selector unexpectedly accepted';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  BEGIN
    UPDATE content_access_requests
       SET status = 'approved', reviewed_by = 'requester-1', reviewed_at = now(),
           expires_at = now() + interval '15 minutes'
     WHERE id = '30000000-0000-0000-0000-000000000008';
    RAISE EXCEPTION 'maker-checker self approval unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO content_access_requests (
      tenant_id, application_id, resource_type, resource_id, source_digest,
      requester_id, purpose, reason
    ) VALUES (
      '30000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000002',
      'INCIDENT_EVIDENCE', 'incident-governance-test', repeat('9', 64),
      'requester-1', 'REGULATORY_REVIEW', 'Duplicate pending request test'
    );
    RAISE EXCEPTION 'duplicate pending evidence request unexpectedly accepted';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END
$p5_governance$;

DO $immutability$
BEGIN
  BEGIN
    UPDATE dictionary_releases
       SET content_hash = repeat('b', 64)
     WHERE id = '30000000-0000-0000-0000-000000000004';
    RAISE EXCEPTION 'dictionary content mutation unexpectedly accepted';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'dictionary release content is immutable' THEN RAISE; END IF;
  END;

  BEGIN
    DELETE FROM dictionary_releases
     WHERE id = '30000000-0000-0000-0000-000000000004';
    RAISE EXCEPTION 'dictionary deletion unexpectedly accepted';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'dictionary releases are append-only' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE dictionary_release_transitions
       SET action = 'tamper'
     WHERE id = '30000000-0000-0000-0000-000000000005';
    RAISE EXCEPTION 'transition mutation unexpectedly accepted';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'dictionary release transitions are append-only' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE content_access_requests
       SET source_digest = repeat('0', 64)
     WHERE id = '30000000-0000-0000-0000-000000000008';
    RAISE EXCEPTION 'content access request identity mutation unexpectedly accepted';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'content access request identity is immutable' THEN RAISE; END IF;
  END;

  BEGIN
    DELETE FROM content_access_requests
     WHERE id = '30000000-0000-0000-0000-000000000008';
    RAISE EXCEPTION 'content access request deletion unexpectedly accepted';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'content access requests are append-preserved' THEN RAISE; END IF;
  END;

  BEGIN
    UPDATE response_templates
       SET template_text = 'tampered'
     WHERE id = '30000000-0000-0000-0000-000000000006';
    RAISE EXCEPTION 'approved template mutation unexpectedly accepted';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'approved response template content is immutable' THEN RAISE; END IF;
  END;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'badcase_feedback'
       AND column_name IN ('raw_content', 'raw_text', 'input_text', 'payload')
  ) THEN
    RAISE EXCEPTION 'badcase feedback contains a forbidden raw-content column';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'content_access_requests'
       AND column_name IN ('raw_content', 'raw_text', 'input_text', 'output_text', 'payload', 'evidence')
  ) THEN
    RAISE EXCEPTION 'content access request contains a forbidden raw-evidence column';
  END IF;
END
$immutability$;

ROLLBACK;
