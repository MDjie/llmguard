import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
async function main() {
  const [mode, script] = process.argv.slice(2);
  if (!['FULL_BUFFER', 'WINDOW'].includes(mode) || !/^scripts\/integration\/[a-z0-9-]+\.mjs$/.test(script ?? '')) throw new Error('Use FULL_BUFFER|WINDOW scripts/integration/<test>.mjs');
  const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
  const environment: Record<string, string> = JSON.parse(readFileSync(path.join(directory, 'environment.json'), 'utf8'));
  const fixture: { tenantId: string; applicationId: string } = JSON.parse(readFileSync(path.join(directory, 'fixture.json'), 'utf8'));
  const url = new URL(environment.PGDATABASE_URL), qualificationFile = path.resolve(environment.GATEWAY_STREAM_QUALIFICATIONS_FILE);
  if (url.hostname !== '127.0.0.1' || url.port !== '55447' || url.pathname !== '/guardllm_integration_gateway_v2' || path.dirname(qualificationFile) !== directory) throw new Error('ISOLATED_PROFILE_REQUIRED');
  const original = readFileSync(qualificationFile, 'utf8');
  if (mode === 'WINDOW' && JSON.parse(original).length === 0) throw new Error('EXISTING_ENGINEERING_WINDOW_QUALIFICATION_REQUIRED');
  Object.assign(process.env, environment);
  const [{ db, closeDatabaseConnection }, { applicationPolicyBindings }, { scopePredicate }, { refreshGatewayPublication }] = await Promise.all([
    import('../../src/storage/database/shared/db'), import('../../src/storage/database/shared/schema'), import('../../src/lib/tenancy'), import('../../src/lib/gateway-runtime/publication'),
  ]);
  const scope = { tenantId: fixture.tenantId, applicationId: fixture.applicationId };
  async function refresh() { const [binding] = await db.select().from(applicationPolicyBindings).where(scopePredicate(applicationPolicyBindings, scope)); await refreshGatewayPublication(scope, 'isolated-profile-fixture', binding.generation); }
  try {
    // Preflight the exact restore target before touching qualifications or publication.
    await refresh();
    if (mode === 'FULL_BUFFER') writeFileSync(qualificationFile, '[]');
    await refresh(); console.log('ISOLATED_PROFILE ' + mode);
    process.exitCode = await new Promise<number>((resolve, reject) => { const child = spawn(process.execPath, [script], { stdio: 'inherit', windowsHide: true }); child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
  } finally { try { writeFileSync(qualificationFile, original); await refresh(); } finally { await closeDatabaseConnection(); } }
}
main().catch((error: unknown) => { const code = error instanceof Error && /^[A-Z][A-Z0-9_]*$/.test(error.message) ? error.message : 'UNCLASSIFIED'; console.error('ISOLATED_PROFILE_RUN_FAILED ' + code); process.exitCode = 1; });
