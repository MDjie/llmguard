import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { canonicalJson, sha256 } from '../../src/lib/gateway-runtime/protocol';
async function main() {
const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
const environment: Record<string, string> = JSON.parse(readFileSync(path.join(directory, 'environment.json'), 'utf8'));
const fixture = JSON.parse(readFileSync(path.join(directory, 'fixture.json'), 'utf8')) as { tenantId: string; applicationId: string };
const url = new URL(environment.PGDATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.pathname !== '/guardllm_integration_gateway_v2') throw new Error('ISOLATED_DATABASE_REQUIRED');
const db = new pg.Client({ connectionString: environment.PGDATABASE_URL, ssl: false });
await db.connect();
try {
  const { rows } = await db.query('select b.canonical_json as payload from policy_bundles b join gateway_runtime_snapshots s on s.bundle_id=b.id and s.tenant_id=b.tenant_id and s.application_id=b.application_id where s.tenant_id=$1 and s.application_id=$2 order by s.created_at desc limit 1', [fixture.tenantId, fixture.applicationId]);
  if (rows.length !== 1) throw new Error('ISOLATED_SNAPSHOT_REQUIRED');
  const entry = { ...fixture, bundleDigest: sha256(canonicalJson(rows[0].payload)), qualificationId: 'isolated-window-engineering-20260907', qualificationExpiresAt: Date.now() + 86400000,
    contextChars: 2048, chunkChars: 1024, holdbackChars: 256, evidenceClass: 'ENGINEERING', datasetSha256: sha256('synthetic-window-boundaries-v1'), reviewReference: 'isolated-regression-only-not-production-quality', riskIds: ['synthetic-window-boundaries'], prefixSafe: true, gateResult: 'PASS' };
  // Persist only scope fields; the credential fixture includes a secret API key.
  const safe = { ...entry, tenantId: fixture.tenantId, applicationId: fixture.applicationId };
  for (const key of Object.keys(fixture)) if (key !== 'tenantId' && key !== 'applicationId') delete (safe as Record<string, unknown>)[key];
  const file = path.join(directory, 'window-qualifications.json'); writeFileSync(file, JSON.stringify([safe], null, 2));
  environment.GATEWAY_STREAM_QUALIFICATIONS_FILE = file; delete environment.GATEWAY_STREAM_QUALIFICATIONS_JSON;
  writeFileSync(path.join(directory, 'environment.json'), JSON.stringify(environment, null, 2));
  console.log('Prepared isolated engineering window qualification; restart isolated control to load file reference. No production qualification claimed.');
} finally { await db.end(); }

}
main().catch(error => { console.error(error instanceof Error ? error.message : 'WINDOW_SETUP_FAILED'); process.exitCode = 1; });
