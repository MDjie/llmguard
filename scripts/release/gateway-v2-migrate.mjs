import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
const sha = value => createHash('sha256').update(value).digest('hex');
const root = path.resolve(import.meta.dirname, '../..'), migrationDirectory = path.join(root, 'drizzle');
function migrations(from) {
  if (!Number.isSafeInteger(from) || from < 47 || from > 9999) throw new Error('GATEWAY_EXPANSION_RANGE_INVALID');
  const files = readdirSync(migrationDirectory).filter(file => /^\d{4}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 4)) >= from).sort();
  if (!files.length || Number(files[0].slice(0, 4)) !== from) throw new Error('MIGRATION_START_NOT_FOUND');
  if (files.some((file, index) => index > 0 && Number(file.slice(0, 4)) !== Number(files[index - 1].slice(0, 4)) + 1)) throw new Error('MIGRATION_RANGE_GAP');
  return files.map(file => ({ file, sha256: sha(readFileSync(path.join(migrationDirectory, file))) }));
}
function validatePlan(plan) {
  if (!plan || plan.version !== '1.0' || !Array.isArray(plan.migrations) || !plan.migrations.length || plan.migrations.length > 1000 ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9_$-]{0,62}$/u.test(plan.database ?? '') || !/^[a-f0-9]{64}$/u.test(plan.schemaDigest ?? '')) throw new Error('MIGRATION_PLAN_INVALID');
  if (new Set(plan.migrations.map(item => item.file)).size !== plan.migrations.length) throw new Error('DUPLICATE_MIGRATION');
  for (const item of plan.migrations) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/u.test(item.file) || Number(item.file.slice(0, 4)) < 47 || !/^[a-f0-9]{64}$/u.test(item.sha256) ||
      sha(readFileSync(path.join(migrationDirectory, item.file))) !== item.sha256) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
  }
  const actual = migrations(Number(plan.migrations[0].file.slice(0, 4))).slice(0, plan.migrations.length);
  if (JSON.stringify(actual) !== JSON.stringify(plan.migrations)) throw new Error('ORDERED_MIGRATION_PLAN_REQUIRED');
  return plan;
}
async function main() {
  const { values } = parseArgs({ options: { mode: { type: 'string', default: 'plan' }, config: { type: 'string' }, output: { type: 'string' },
    plan: { type: 'string' }, 'expected-database': { type: 'string' }, from: { type: 'string', default: '47' } }, strict: true });
  if (!values.config || !values.output || !['plan', 'apply'].includes(values.mode)) throw new Error('Use --mode plan|apply --config <private DB JSON> --output <new report.json> [--from 47] [--plan <reviewed plan.json> --expected-database <name>]');
  const config = JSON.parse(readFileSync(values.config, 'utf8')), url = new URL(config.databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.searchParams.has('sslmode') || [...url.searchParams.keys()].some(key => key.startsWith('ssl'))) throw new Error('STRUCTURED_VERIFIED_TLS_CONFIGURATION_REQUIRED');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local && !config.caFile) throw new Error('REMOTE_DATABASE_CA_REQUIRED');
  const plan = values.mode === 'apply' ? validatePlan(JSON.parse(readFileSync(values.plan ?? '', 'utf8'))) : null;
  if (plan && (!values['expected-database'] || values['expected-database'] !== plan.database || decodeURIComponent(url.pathname.slice(1)) !== plan.database)) throw new Error('EXPECTED_DATABASE_MISMATCH');
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 10000, query_timeout: 180000,
    ssl: config.caFile ? { ca: readFileSync(config.caFile, 'utf8'), rejectUnauthorized: true } : false, application_name: 'guardllm-gateway-upgrade' });
  await client.connect(); let locked = false;
  try {
    await client.query("SET lock_timeout='5s'; SET statement_timeout='120s'");
    const identity = (await client.query('select current_database() as name,current_setting(\'server_version_num\')::int as version')).rows[0];
    if (identity.version < 140000) throw new Error('POSTGRESQL_14_OR_NEWER_REQUIRED');
    if (plan && identity.name !== plan.database) throw new Error('CONNECTED_DATABASE_MISMATCH');
    const tables = (await client.query("SELECT to_regclass('public.applications') AS applications,to_regclass('public.policy_bundles') AS bundles,to_regclass('public.application_policy_bindings') AS bindings")).rows[0];
    if (Object.values(tables).some(value => !value)) throw new Error('BASELINE_SCHEMA_REQUIRED_INSTALL_0001_TO_0046_FIRST');
    const shape = (await client.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name<>'guardllm_gateway_upgrade_migrations' ORDER BY table_name,ordinal_position")).rows;
    if (!plan) {
      const report = { version: '1.0', mode: 'PLAN_ONLY', generatedAt: new Date().toISOString(), database: identity.name, serverVersion: identity.version,
        schemaDigest: sha(JSON.stringify(shape)), migrations: migrations(Number(values.from)), lockTimeoutMs: 5000, statementTimeoutMs: 120000,
        destructiveContraction: false, backupRequiredBeforeApply: true,
        note: 'Read-only inspection; no SQL or migration ledger was written. Back up and trial-restore before applying. Each migration commits with its checksum; reruns resume and reject altered SQL. Existing SQL may require locks or table scans.' };
      writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log(JSON.stringify({ mode: report.mode, migrations: report.migrations.length, schemaDigest: report.schemaDigest })); return;
    }
    const acquired = (await client.query("SELECT pg_try_advisory_lock(hashtextextended('guardllm-gateway-upgrade',0)) AS acquired")).rows[0].acquired;
    if (!acquired) throw new Error('ANOTHER_UPGRADE_IS_RUNNING'); locked = true;
    const ledger = (await client.query("SELECT to_regclass('public.guardllm_gateway_upgrade_migrations') AS ledger")).rows[0].ledger;
    const previous = ledger ? (await client.query('SELECT file,sha256 FROM public.guardllm_gateway_upgrade_migrations')).rows : [];
    for (const old of previous) {
      const matching = plan.migrations.find(item => item.file === old.file);
      if (matching && matching.sha256 !== old.sha256) throw new Error('APPLIED_MIGRATION_CHECKSUM_CHANGED');
    }
    if (!previous.some(old => plan.migrations.some(item => item.file === old.file)) && sha(JSON.stringify(shape)) !== plan.schemaDigest) throw new Error('SCHEMA_CHANGED_SINCE_PLAN');
    const outcomes = [];
    for (const item of plan.migrations) {
      if (previous.some(old => old.file === item.file)) { outcomes.push({ ...item, state: 'ALREADY_APPLIED' }); continue; }
      const sql = readFileSync(path.join(migrationDirectory, item.file), 'utf8');
      // Hash the bytes used by this transaction again to detect edits after plan validation.
      if (sha(Buffer.from(sql)) !== item.sha256) throw new Error('MIGRATION_CHANGED_BEFORE_APPLY');
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s'");
        await client.query('CREATE TABLE IF NOT EXISTS public.guardllm_gateway_upgrade_migrations(file varchar(256) PRIMARY KEY,sha256 varchar(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
        await client.query(sql);
        await client.query('INSERT INTO public.guardllm_gateway_upgrade_migrations(file,sha256) VALUES($1,$2)', [item.file, item.sha256]);
        await client.query('COMMIT'); outcomes.push({ ...item, state: 'APPLIED' });
      } catch (error) {
        await client.query('ROLLBACK');
        writeFileSync(values.output, JSON.stringify({ version: '1.0', status: 'FAILED_RESUMABLE', outcomes, failedFile: item.file, databaseCode: error.code ?? 'UNKNOWN',
          note: 'Current file rolled back; preceding committed migrations remain. Reuse the unchanged plan to resume after resolving the failure.' }, null, 2), { flag: 'wx' });
        throw new Error('MIGRATION_FAILED_RESUMABLE');
      }
    }
    writeFileSync(values.output, JSON.stringify({ version: '1.0', status: 'PASS', database: plan.database, appliedAt: new Date().toISOString(),
      planSha256: sha(readFileSync(values.plan)), outcomes, rollback: 'Roll back application to a compatible controlled release; do not reverse/delete audit or tool execution data.' }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ status: 'PASS', applied: outcomes.filter(item => item.state === 'APPLIED').length, skipped: outcomes.filter(item => item.state === 'ALREADY_APPLIED').length }));
  } finally { if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('guardllm-gateway-upgrade',0))").catch(() => {}); await client.end(); }
}
main().catch(error => { const code = error instanceof Error && /^[A-Z0-9_:]+$/u.test(error.message) ? error.message : 'GATEWAY_MIGRATION_FAILED'; console.error(code); process.exitCode = 1; });
