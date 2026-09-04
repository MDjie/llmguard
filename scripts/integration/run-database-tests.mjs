import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const databaseUrl = process.argv.find((argument) => argument.startsWith('postgres://'))
  ?? process.env.INTEGRATION_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('INTEGRATION_DATABASE_URL is required');
}

const parsedUrl = new URL(databaseUrl);
const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
if (!localHosts.has(parsedUrl.hostname) || !parsedUrl.pathname.slice(1).startsWith('guardllm_integration')) {
  throw new Error('Integration tests only run against a local database named guardllm_integration*');
}

const root = resolve(import.meta.dirname, '../..');
const allSqlFiles = [
  'scripts/init-database-new.sql',
  'scripts/init-database-supplement.sql',
  ...readdirSync(resolve(root, 'drizzle'))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .map((name) => `drizzle/${name}`),
];
const sqlFiles = process.argv.includes('--policy-governance-schema-only')
  ? [
      'drizzle/0037_targeted_whitelist_rules.sql',
      'drizzle/0038_policy_governance.sql',
      'drizzle/0040_output_control_governance.sql',
      'drizzle/0041_policy_operations_governance.sql',
    ]
  : allSqlFiles;
const client = new pg.Client({
  connectionString: databaseUrl,
  ssl: false,
});

try {
  await client.connect();
  if (process.argv.includes('--apply-schema') || process.env.INTEGRATION_APPLY_SCHEMA === 'true') {
    for (const relativePath of sqlFiles) {
      await client.query(readFileSync(resolve(root, relativePath), 'utf8'));
    }
  }

  const isolationSql = readFileSync(resolve(root, 'tests/integration/tenancy-isolation.sql'), 'utf8')
    .replace(/^\\set[^\n]*\r?\n/u, '');
  await client.query(isolationSql);
  const lineageSql = readFileSync(resolve(root, 'tests/integration/data-lineage.sql'), 'utf8')
    .replace(/^\\set[^\n]*\r?\n/u, '');
  await client.query(lineageSql);
  const policyGovernanceSql = readFileSync(resolve(root, 'tests/integration/policy-governance.sql'), 'utf8')
    .replace(/^\\set[^\n]*\r?\n/u, '');
  await client.query(policyGovernanceSql);

  const requiredRelations = [
    'security_audit_events',
    'audit_export_outbox',
    'generated_content_marks',
    'data_catalog_entries',
    'security_incidents',
    'password_history',
    'policy_bundle_transitions',
    'guard_session_risk_states',
    'generated_content_derivatives',
    'audit_evidence_timestamps',
    'data_lineage_edges',
    'data_deletion_proofs',
    'dictionary_releases',
    'dictionary_release_transitions',
    'response_templates',
    'detector_calibrations',
    'badcase_feedback',
    'content_access_requests',
  ];
  const relations = await client.query(
    'select tablename from pg_tables where schemaname = current_schema() and tablename = any($1::text[])',
    [requiredRelations],
  );
  const foundRelations = new Set(relations.rows.map((row) => String(row.tablename)));
  const missingRelations = requiredRelations.filter((name) => !foundRelations.has(name));
  if (missingRelations.length > 0) {
    throw new Error(`Missing required migrated relations: ${missingRelations.join(', ')}`);
  }

  const requiredScopeConstraints = [
    'dictionary_releases_application_scope_fk',
    'dictionary_release_transitions_application_scope_fk',
    'dictionary_release_transitions_scope_fk',
    'dictionary_releases_rollback_scope_fk',
    'response_templates_application_scope_fk',
    'keyword_rules_release_scope_fk',
    'detector_calibrations_application_scope_fk',
    'badcase_feedback_application_scope_fk',
    'content_access_requests_application_scope_fk',
  ];
  const scopeConstraints = await client.query(
    'select conname from pg_constraint where conname = any($1::text[])',
    [requiredScopeConstraints],
  );
  const foundScopeConstraints = new Set(scopeConstraints.rows.map((row) => String(row.conname)));
  const missingScopeConstraints = requiredScopeConstraints.filter(
    (name) => !foundScopeConstraints.has(name),
  );
  if (missingScopeConstraints.length > 0) {
    throw new Error(
      `Missing policy governance scope constraints: ${missingScopeConstraints.join(', ')}`,
    );
  }

  const requiredP3Columns = [
    ['guard_memory_risk_ledgers', 'intent_nodes'],
    ['guard_memory_risk_ledgers', 'state_transitions'],
    ['agent_lifecycle_budgets', 'media_frames'],
    ['agent_lifecycle_budgets', 'maximum_media_frames'],
    ['agent_lifecycle_budgets', 'decoding_branches'],
    ['agent_lifecycle_budgets', 'maximum_decoding_branches'],
    ['agent_lifecycle_budgets', 'judge_calls'],
    ['agent_lifecycle_budgets', 'maximum_judge_calls'],
    ['agent_lifecycle_budgets', 'decompressed_bytes'],
    ['agent_lifecycle_budgets', 'maximum_decompressed_bytes'],
  ];
  const p3Columns = await client.query(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = current_schema()
        and table_name = any($1::text[])
        and column_name = any($2::text[])`,
    [
      [...new Set(requiredP3Columns.map(([table]) => table))],
      [...new Set(requiredP3Columns.map(([, column]) => column))],
    ],
  );
  const foundP3Columns = new Set(p3Columns.rows.map(
    (row) => `${String(row.table_name)}:${String(row.column_name)}`,
  ));
  const missingP3Columns = requiredP3Columns.filter(
    ([table, column]) => !foundP3Columns.has(`${table}:${column}`),
  );
  if (missingP3Columns.length > 0) {
    throw new Error(`Missing P3 migrated columns: ${missingP3Columns
      .map(([table, column]) => `${table}.${column}`).join(', ')}`);
  }

  const requiredP3Constraints = [
    'guard_memory_risk_ledgers_state_check',
    'guard_memory_risk_ledgers_intent_nodes_array_check',
    'guard_memory_risk_ledgers_state_transitions_array_check',
    'agent_lifecycle_budgets_p3_nonnegative_check',
  ];
  const p3Constraints = await client.query(
    'select conname from pg_constraint where conname = any($1::text[])',
    [requiredP3Constraints],
  );
  const foundP3Constraints = new Set(p3Constraints.rows.map((row) => String(row.conname)));
  const missingP3Constraints = requiredP3Constraints.filter(
    (name) => !foundP3Constraints.has(name),
  );
  if (missingP3Constraints.length > 0) {
    throw new Error(`Missing P3 constraints: ${missingP3Constraints.join(', ')}`);
  }

  const requiredP4Columns = [
    ['response_templates', 'jurisdiction'],
    ['response_templates', 'business_line'],
    ['response_templates', 'legal_disclaimer_version'],
    ['response_templates', 'template_scope'],
  ];
  const p4Columns = await client.query(
    `select table_name, column_name, is_nullable
       from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'response_templates'
        and column_name = any($1::text[])`,
    [requiredP4Columns.map(([, column]) => column)],
  );
  const foundP4Columns = new Map(p4Columns.rows.map(
    (row) => [`${String(row.table_name)}:${String(row.column_name)}`, String(row.is_nullable)],
  ));
  const missingP4Columns = requiredP4Columns.filter(
    ([table, column]) => !foundP4Columns.has(`${table}:${column}`),
  );
  if (missingP4Columns.length > 0) {
    throw new Error(`Missing P4 migrated columns: ${missingP4Columns
      .map(([table, column]) => `${table}.${column}`).join(', ')}`);
  }
  const nullableP4Columns = requiredP4Columns.filter(
    ([table, column]) => foundP4Columns.get(`${table}:${column}`) !== 'NO',
  );
  if (nullableP4Columns.length > 0) {
    throw new Error(`Nullable P4 governed columns: ${nullableP4Columns
      .map(([table, column]) => `${table}.${column}`).join(', ')}`);
  }

  const p4Constraint = await client.query(
    "select 1 from pg_constraint where conname = 'response_templates_scope_check'",
  );
  if (p4Constraint.rowCount !== 1) {
    throw new Error('P4 response-template scope constraint is missing');
  }
  const p4Index = await client.query(
    `select indexdef
       from pg_indexes
      where schemaname = current_schema()
        and indexname = 'response_templates_runtime_selector_idx'`,
  );
  const indexDefinition = String(p4Index.rows[0]?.indexdef ?? '');
  for (const column of [
    'tenant_id',
    'application_id',
    'action',
    'locale',
    'industry',
    'jurisdiction',
    'business_line',
    'enabled',
  ]) {
    if (!indexDefinition.includes(column)) {
      throw new Error(`P4 response-template selector index is missing ${column}`);
    }
  }

  const requiredP5Columns = [
    ['content_access_requests', 'source_digest'],
    ['content_access_requests', 'purpose'],
    ['content_access_requests', 'reviewed_by'],
    ['content_access_requests', 'reviewed_at'],
    ['content_access_requests', 'expires_at'],
    ['content_access_requests', 'used_at'],
  ];
  const p5Columns = await client.query(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'content_access_requests'
        and column_name = any($1::text[])`,
    [requiredP5Columns.map(([, column]) => column)],
  );
  const foundP5Columns = new Set(p5Columns.rows.map(
    (row) => `${String(row.table_name)}:${String(row.column_name)}`,
  ));
  const missingP5Columns = requiredP5Columns.filter(
    ([table, column]) => !foundP5Columns.has(`${table}:${column}`),
  );
  if (missingP5Columns.length > 0) {
    throw new Error(`Missing P5 migrated columns: ${missingP5Columns
      .map(([table, column]) => `${table}.${column}`).join(', ')}`);
  }

  const requiredP5Constraints = [
    'content_access_requests_resource_ck',
    'content_access_requests_purpose_ck',
    'content_access_requests_digest_ck',
    'content_access_requests_status_ck',
    'content_access_requests_review_ck',
    'content_access_requests_expiry_ck',
    'content_access_requests_use_ck',
  ];
  const p5Constraints = await client.query(
    'select conname from pg_constraint where conname = any($1::text[])',
    [requiredP5Constraints],
  );
  const foundP5Constraints = new Set(p5Constraints.rows.map((row) => String(row.conname)));
  const missingP5Constraints = requiredP5Constraints.filter(
    (name) => !foundP5Constraints.has(name),
  );
  if (missingP5Constraints.length > 0) {
    throw new Error(`Missing P5 constraints: ${missingP5Constraints.join(', ')}`);
  }

  const requiredP5Indexes = [
    'dictionary_releases_one_active_uq',
    'response_templates_one_active_selector_uq',
    'content_access_requests_pending_uq',
  ];
  const p5Indexes = await client.query(
    'select indexname, indexdef from pg_indexes where schemaname = current_schema() and indexname = any($1::text[])',
    [requiredP5Indexes],
  );
  const p5IndexDefinitions = new Map(p5Indexes.rows.map(
    (row) => [String(row.indexname), String(row.indexdef)],
  ));
  const missingP5Indexes = requiredP5Indexes.filter((name) => !p5IndexDefinitions.has(name));
  if (missingP5Indexes.length > 0) {
    throw new Error(`Missing P5 indexes: ${missingP5Indexes.join(', ')}`);
  }
  for (const name of requiredP5Indexes) {
    if (!p5IndexDefinitions.get(name)?.includes(' WHERE ')) {
      throw new Error(`P5 governance index must be partial: ${name}`);
    }
  }

  const p5IdentityTrigger = await client.query(
    `select 1
       from pg_trigger trigger
       join pg_class relation on relation.oid = trigger.tgrelid
      where relation.relname = 'content_access_requests'
        and trigger.tgname = 'content_access_requests_identity_immutable'
        and not trigger.tgisinternal`,
  );
  if (p5IdentityTrigger.rowCount !== 1) {
    throw new Error('P5 content-access identity trigger is missing');
  }

  const forbiddenP5Columns = await client.query(
    `select column_name
       from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'content_access_requests'
        and column_name = any($1::text[])`,
    [['raw_content', 'raw_text', 'input_text', 'output_text', 'payload', 'evidence']],
  );
  if (forbiddenP5Columns.rowCount !== 0) {
    throw new Error('P5 content-access requests persist forbidden raw evidence');
  }

  const appendOnlyTrigger = await client.query(
    `select 1
       from pg_trigger trigger
       join pg_class relation on relation.oid = trigger.tgrelid
      where relation.relname = 'security_audit_events'
        and trigger.tgname = 'security_audit_events_append_only'
        and not trigger.tgisinternal`,
  );
  if (appendOnlyTrigger.rowCount !== 1) {
    throw new Error('Tamper-evident audit append-only trigger is missing');
  }

  process.stdout.write(JSON.stringify({
    status: 'PASS',
    migrations: sqlFiles.length,
    requiredRelations: requiredRelations.length,
    tenancyIsolation: 'PASS',
    dataLineageConstraints: 'PASS',
    appendOnlyAudit: 'PASS',
    policyGovernanceConstraints: 'PASS',
    policyGovernanceScopeConstraints: requiredScopeConstraints.length,
    p3SchemaColumns: requiredP3Columns.length,
    p3SchemaConstraints: requiredP3Constraints.length,
    p4SchemaColumns: requiredP4Columns.length,
    p4SchemaConstraints: 1,
    p4SelectorIndex: 'PASS',
    p5SchemaColumns: requiredP5Columns.length,
    p5SchemaConstraints: requiredP5Constraints.length,
    p5GovernanceIndexes: requiredP5Indexes.length,
    p5ContentAccessIdentity: 'PASS',
    p5RawEvidencePersistence: 'PASS',
  }) + '\n');
} finally {
  await client.end();
}
