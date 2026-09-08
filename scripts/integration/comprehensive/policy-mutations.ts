import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb, transactionalCompatibilityHandler, afterCompatibilityCommit } from '../../../src/lib/db';
import { runWithTenantScope } from '../../../src/lib/tenancy/runtime';
import { db, closeDatabaseConnection } from '../../../src/storage/database/shared/db';
import { policyProfiles, policyRules } from '../../../src/storage/database/shared/schema';
import { PostgresRateLimiter } from '../../../src/lib/api-security/postgres-rate-limit';
async function main() {
 const out = process.env.COMPREHENSIVE_RUN_DIR!;
 const fixture = JSON.parse(readFileSync(out + '/fixture.private.json', 'utf8')) as { tenantId: string; applicationId: string; policyId: string };
 const results: Array<{ id: string; status: string }> = [];
 await runWithTenantScope(fixture, async () => {
  const client = getDb(); const id = randomUUID();
  const before = await db.select().from(policyRules).where(eq(policyRules.policyId, fixture.policyId));
  const created = await client.from('policy_profiles').insert({ id, name: 'mutation-' + id }).select().single();
  assert.equal(created.error, null); assert.equal(created.data?.id, id); assert.notEqual(id, fixture.policyId);
  const updated = await client.from('policy_profiles').update({ description: 'persisted' }).eq('id', id).select().maybeSingle(); assert.equal(updated.data?.description, 'persisted');
  assert.equal((await db.select().from(policyProfiles).where(eq(policyProfiles.id, id)))[0].description, 'persisted');
  results.push({ id: 'PG-MUTATION-RETURNING', status: 'PASS' });
  let cleared = false; const rollbackId = randomUUID();
  const response = await transactionalCompatibilityHandler(async () => {
   await client.from('policy_profiles').insert({ id: rollbackId, name: 'rollback-' + rollbackId }).single();
   await client.from('policy_rules').insert({ policy_id: rollbackId, dimension: 'x', warn_threshold: 'invalid-numeric' });
   afterCompatibilityCommit(() => { cleared = true; }); return Response.json({ success: true });
  })();
  assert.equal(response.status, 500); assert.equal(cleared, false); assert.equal((await db.select().from(policyProfiles).where(eq(policyProfiles.id, rollbackId))).length, 0);
  assert.deepEqual(await db.select().from(policyRules).where(eq(policyRules.policyId, fixture.policyId)), before);
  results.push({ id: 'PG-MULTISTEP-ROLLBACK', status: 'PASS' });
  const deleted = await client.from('policy_profiles').delete().eq('id', id).select().single(); assert.equal(deleted.data?.id, id);
  assert.equal((await db.select().from(policyProfiles).where(eq(policyProfiles.id, id))).length, 0);
  results.push({ id: 'PG-DELETE-RETURNING', status: 'PASS' });
 });
 let now = Date.now(); let fallbacks = 0;
 const execute = async (query: Parameters<typeof db.execute>[0]) => { const rows = await db.execute(query); return { rows: [...rows] as Record<string, unknown>[] }; };
 const replicaA = new PostgresRateLimiter(execute, () => now, undefined, () => { fallbacks++; });
 const replicaB = new PostgresRateLimiter(execute, () => now, undefined, () => { fallbacks++; });
 const policy = { id: 'pg-real-' + randomUUID(), windowMs: 60000, maxRequests: 3, scope: 'principal' as const };
 const states = []; for (const replica of [replicaA, replicaB, replicaA, replicaB]) states.push((await replica.consume('same-principal', policy)).allowed);
 assert.deepEqual(states, [true, true, true, false]); assert.equal(fallbacks, 0);
 now += 60000; assert.equal((await replicaB.consume('same-principal', policy)).allowed, true); assert.equal(fallbacks, 0);
 const counts = await db.execute(sql`select count(*)::int count from rate_limit_buckets`); assert.ok(Number(counts[0]?.count) > 0);
 results.push({ id: 'PG-REAL-DRIVER-SHARED-LIMITER', status: 'PASS' });
 writeFileSync(out + '/policy-mutations.json', JSON.stringify({ status: 'PASS', results }, null, 2)); console.log(JSON.stringify(results));
}
main().finally(closeDatabaseConnection).catch(error => { console.error(error instanceof Error ? error.message : 'INTEGRATION_FAILED'); process.exitCode = 1; });
