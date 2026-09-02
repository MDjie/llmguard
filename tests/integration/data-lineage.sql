BEGIN;

INSERT INTO tenants (id, code, name)
VALUES (
  '20000000-0000-0000-0000-000000000001',
  'lineage-test',
  'Lineage test'
);

INSERT INTO applications (id, tenant_id, code, name)
VALUES (
  '20000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000001',
  'default',
  'Lineage app'
);

INSERT INTO data_lineage_edges (
  tenant_id, application_id, source_type, source_id,
  target_type, target_id, operation, processor_id,
  processor_version, attributes, evidence_hash
) VALUES (
  '20000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000002',
  'ARTIFACT', 'artifact-1', 'RAG_CHUNK', 'chunk-1',
  'RAG_INGEST', 'guardllm-rag-ingest', '1.0',
  '{"state":"accepted"}'::jsonb,
  repeat('a', 64)
);

INSERT INTO data_deletion_proofs (
  proof_id, version, cutoff, manifest, phases,
  completed_at, key_id, signature
) VALUES (
  '22222222-2222-4222-8222-222222222222',
  '1.0',
  '2026-08-26T00:00:00Z',
  '[{"objectType":"SESSION","count":1,"idDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb,
  '{"database":{"state":"COMPLETE"}}'::jsonb,
  '2026-09-02T05:00:00Z',
  'deletion-proof-v1',
  repeat('b', 64)
);

DO $assertions$
BEGIN
  BEGIN
    INSERT INTO data_lineage_edges (
      tenant_id, application_id, source_type, source_id,
      target_type, target_id, operation, processor_id,
      processor_version, attributes, evidence_hash
    ) VALUES (
      '20000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000002',
      'ARTIFACT', 'artifact-1', 'RAG_CHUNK', 'chunk-1',
      'RAG_INGEST', 'guardllm-rag-ingest', '2.0',
      '{}'::jsonb,
      repeat('c', 64)
    );
    RAISE EXCEPTION 'duplicate lineage identity unexpectedly accepted';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO data_lineage_edges (
      tenant_id, application_id, source_type, source_id,
      target_type, target_id, operation, processor_id,
      processor_version, attributes, evidence_hash
    ) VALUES (
      '20000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000002',
      'invalid type', 'artifact-2', 'RAG_CHUNK', 'chunk-2',
      'RAG_INGEST', 'guardllm-rag-ingest', '1.0',
      '{}'::jsonb,
      repeat('d', 64)
    );
    RAISE EXCEPTION 'invalid lineage type unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO data_deletion_proofs (
      proof_id, version, cutoff, manifest, phases,
      completed_at, key_id, signature
    ) VALUES (
      '33333333-3333-4333-8333-333333333333',
      '1.0',
      now(),
      '[]'::jsonb,
      '{}'::jsonb,
      now(),
      'deletion-proof-v1',
      repeat('e', 64)
    );
    RAISE EXCEPTION 'empty deletion manifest unexpectedly accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$assertions$;

ROLLBACK;
