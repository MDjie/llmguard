import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';

const root = path.resolve(import.meta.dirname, '../..');
const directory = path.join(root, '.artifact-build/upgrade-implementation-20260907/environment');
const environment = JSON.parse(readFileSync(path.join(directory, 'environment.json'), 'utf8'));
const originalUrl = new URL(environment.PGDATABASE_URL);
if (originalUrl.hostname !== '127.0.0.1' || originalUrl.port !== '55447' || originalUrl.pathname !== '/guardllm_integration_gateway_v2') {
  throw new Error('ISOLATED_DATABASE_REQUIRED');
}
const name = 'guardllm_integration_init_' + randomUUID().replaceAll('-', '');
if (!/^guardllm_integration_init_[a-f0-9]{32}$/.test(name)) throw new Error('UNSAFE_DATABASE_NAME');
const isolatedUrl = new URL(originalUrl); isolatedUrl.pathname = '/' + name;
const admin = new pg.Client({ connectionString: originalUrl.toString(), ssl: false });
let created = false, verified = false;
await admin.connect();
try {
  // A fresh database proves that migration initialization works, without touching the proxy fixture.
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/integration/run-database-tests.mjs', '--apply-schema'], {
      cwd: root, env: { ...process.env, INTEGRATION_DATABASE_URL: isolatedUrl.toString() }, stdio: 'inherit', windowsHide: true,
    });
    child.on('error', reject); child.on('exit', code => resolve(code ?? 1));
  });
  assert.equal(status, 0, 'FRESH_DATABASE_INITIALIZATION_FAILED');
  const check = new pg.Client({ connectionString: isolatedUrl.toString(), ssl: false }); await check.connect();
  try {
    const rows = (await check.query("select tablename from pg_tables where schemaname='public' and tablename=any($1::text[])", [['gateway_request_resources', 'gateway_shadow_evaluations', 'decision_record_outbox', 'security_alerts', 'conversation_archives', 'archived_content_objects', 'badcase_feedback_reviews']])).rows;
    assert.equal(rows.length, 7, 'LATEST_GATEWAY_RELATIONS_MISSING');
    const compose = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    assert.ok(compose.includes('./drizzle/0057_gateway_request_resources.sql:/docker-entrypoint-initdb.d/67-gateway-request-resources.sql:ro'));
    assert.ok(compose.includes('./drizzle/0058_gateway_shadow_evaluations.sql:/docker-entrypoint-initdb.d/68-gateway-shadow-evaluations.sql:ro'));
    assert.ok(compose.includes('./drizzle/0059_security_alert_projection.sql:/docker-entrypoint-initdb.d/69-security-alert-projection.sql:ro'));
    assert.ok(compose.includes('./drizzle/0060_conversation_archive.sql:/docker-entrypoint-initdb.d/70-conversation-archive.sql:ro'));
    assert.ok(compose.includes('./drizzle/0061_badcase_independent_review.sql:/docker-entrypoint-initdb.d/71-badcase-independent-review.sql:ro'));
    assert.ok(compose.includes('./drizzle/0062_alert_projection_recovery.sql:/docker-entrypoint-initdb.d/72-alert-projection-recovery.sql:ro'));
    assert.equal((await check.query("select count(*)::int as n from information_schema.columns where table_name='decision_record_outbox' and column_name in ('failure_code','failed_at','retry_count')")).rows[0].n,3);
    assert.ok(compose.includes('./drizzle/0063_media_evidence_snapshots.sql:/docker-entrypoint-initdb.d/73-media-evidence-snapshots.sql:ro'));
    assert.equal((await check.query("select to_regclass('media_evidence_snapshots')::text as name")).rows[0].name,'media_evidence_snapshots');
    assert.ok(compose.includes('./drizzle/0064_feedback_candidate_exports.sql:/docker-entrypoint-initdb.d/74-feedback-candidate-exports.sql:ro'));
    assert.equal((await check.query("select to_regclass('feedback_candidate_exports')::text as name")).rows[0].name,'feedback_candidate_exports');
    verified = true;
  } finally { await check.end(); }
} finally {
  // Drop only this invocation's successfully created database, never the existing proxy database.
  if (created) await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
  writeFileSync(path.join(directory, 'initialization-evidence.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), status: verified ? 'PASS' : 'FAIL', freshDatabase: true,
    databaseRemoved: created, existingDatabaseModified: false, latestMigrations: ['0057', '0058', '0059', '0060', '0061', '0062', '0063', '0064'],
    composeMountsChecked: verified, fullComposeStartupTested: false,
  }, null, 2));
}
console.log('PASS fresh migration initialization and latest gateway relations; disposable database removed');
