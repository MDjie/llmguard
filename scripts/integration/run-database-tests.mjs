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
const sqlFiles = [
  'scripts/init-database-new.sql',
  'scripts/init-database-supplement.sql',
  ...readdirSync(resolve(root, 'drizzle'))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .map((name) => `drizzle/${name}`),
];
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
  }) + '\n');
} finally {
  await client.end();
}
