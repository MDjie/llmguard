import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
const environment = JSON.parse(readFileSync(path.join(directory, 'environment.json'), 'utf8'));
const restore = JSON.parse(readFileSync(path.join(directory, 'restore-evidence.json'), 'utf8'));
const url = new URL(environment.PGDATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '55447' || url.pathname !== '/guardllm_integration_gateway_v2' || !/^guardllm_integration_gateway_v2_restore_[0-9]+$/u.test(restore.restoredDatabase)) throw new Error('ISOLATED_RESTORE_REQUIRED');
url.pathname = '/' + restore.restoredDatabase;
const run = path.join(directory, 'migration-runner-' + Date.now()); mkdirSync(run);
const config = path.join(run, 'private-config.json'), planPath = path.join(run, 'plan.json');
writeFileSync(config, JSON.stringify({ databaseUrl: url.toString() }));
const client = new pg.Client({ connectionString: url.toString(), ssl: false }); await client.connect();
const results = [];
function command(args, success = true) {
  const result = spawnSync(process.execPath, ['scripts/release/gateway-v2-migrate.mjs', '--config', config, ...args], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  if (success) assert.equal(result.status, 0, result.stderr); else assert.notEqual(result.status, 0);
  return result;
}
async function check(name, fn) { await fn(); results.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
try {
  await check('plan mode reads schema without adding a migration ledger', async () => {
    const before = (await client.query("select to_regclass('public.guardllm_gateway_upgrade_migrations') as name")).rows[0].name;
    command(['--mode', 'plan', '--output', planPath]); const after = (await client.query("select to_regclass('public.guardllm_gateway_upgrade_migrations') as name")).rows[0].name;
    assert.equal(after, before); assert.equal(JSON.parse(readFileSync(planPath)).mode, 'PLAN_ONLY');
  });
  await check('apply requires exact database and rejects tampered checksums before any DDL', async () => {
    assert.match(command(['--mode', 'apply', '--plan', planPath, '--expected-database', 'wrong_database', '--output', path.join(run, 'wrong.json')], false).stderr, /EXPECTED_DATABASE_MISMATCH/);
    const changed = JSON.parse(readFileSync(planPath)); changed.migrations[0].sha256 = 'f'.repeat(64); const altered = path.join(run, 'altered.json'); writeFileSync(altered, JSON.stringify(changed));
    assert.match(command(['--mode', 'apply', '--plan', altered, '--expected-database', restore.restoredDatabase, '--output', path.join(run, 'changed.json')], false).stderr, /CHECKSUM_MISMATCH/);
  });
  await check('ordered expansion applies with an atomic checksum ledger on the restored database', async () => {
    const output = path.join(run, 'apply.json'); command(['--mode', 'apply', '--plan', planPath, '--expected-database', restore.restoredDatabase, '--output', output]);
    const result = JSON.parse(readFileSync(output)); assert.equal(result.status, 'PASS'); assert.ok(result.outcomes.length >= 9);
    assert.equal(Number((await client.query('select count(*) from public.guardllm_gateway_upgrade_migrations')).rows[0].count), result.outcomes.length);
  });
  await check('retry resumes using existing checksums and skips all previously committed files', async () => {
    const output = path.join(run, 'resume.json'); command(['--mode', 'apply', '--plan', planPath, '--expected-database', restore.restoredDatabase, '--output', output]);
    assert.ok(JSON.parse(readFileSync(output)).outcomes.every(item => item.state === 'ALREADY_APPLIED'));
  });
} finally {
  await client.end(); writeFileSync(path.join(directory, 'migration-runner-evidence.json'), JSON.stringify({ capturedAt: new Date().toISOString(), status: results.length === 4 ? 'PASS' : 'FAIL',
    isolatedRestoredDatabase: true, productionOnlineDdlTested: false, results }, null, 2));
}
