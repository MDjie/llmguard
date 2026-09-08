/** Only seeds synthetic business records into a previously created isolated schema. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DIMENSION_LABELS } from '../../../src/lib/dimension-labels';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { db, closeDatabaseConnection } from '../../../src/storage/database/shared/db';
import { tenants, applications, users, tenantMemberships, policyProfiles, policyRules, detectionDimensions, detectionRules, policyDimensionConfig } from '../../../src/storage/database/shared/schema';
import { bootstrapLocalDefaultPolicyBundle } from '../../../src/lib/policy-bundle/bootstrap';

async function main() {
  const out = resolve(process.env.COMPREHENSIVE_RUN_DIR ?? '');
  const env = z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(out + '/environment.private.json', 'utf8')));
  for (const key of ['DATABASE_URL', 'PGDATABASE_URL', 'COZE_SUPABASE_DB_URL']) {
    const url = new URL(env[key]);
    if (url.hostname !== '127.0.0.1' || url.port !== '5438' || !/^\/guardllm_integration_full_[0-9]+$/.test(url.pathname)) throw new Error('ISOLATED_DATABASE_REQUIRED');
  }
  if (existsSync(out + '/fixture.private.json')) throw new Error('FIXTURE_ALREADY_EXISTS');
  const dimensions = Object.entries(DIMENSION_LABELS).map(([code, name]) => ({ code, name, category: 'content' }));
  const scope = { tenantId: randomUUID(), applicationId: randomUUID() };
  const policyId = randomUUID();
  const fixture: Record<string, unknown> = { ...scope, policyId, scope: 'ISOLATED_CLONE_ENGINEERING_ONLY', dataset: 'SYNTHETIC_ONLY_NEW_EMPTY_DATABASE', baseURL: 'http://127.0.0.1:58089', prefix: 'AUTO260908' };
  await db.transaction(async transaction => {
    await transaction.insert(tenants).values({ id: scope.tenantId, code: 'test-' + scope.tenantId, name: '自动化验收测试租户' });
    await transaction.insert(applications).values({ ...scope, id: scope.applicationId, code: 'full-test', name: '自动化验收应用' });
    for (const kind of ['owner', 'other', 'readonly', 'foreign', 'logoutDesktop', 'logoutMobile'] as const) {
      let tenantId = scope.tenantId, applicationId = scope.applicationId;
      if (kind === 'foreign') {
        tenantId = randomUUID(); applicationId = randomUUID();
        await transaction.insert(tenants).values({ id: tenantId, code: 'test-' + tenantId, name: '自动化隔离对照租户' });
        await transaction.insert(applications).values({ id: applicationId, tenantId, code: 'foreign', name: '自动化隔离对照应用' });
      }
      const userId = randomUUID(), username = 'full_' + kind + '_' + randomUUID().slice(0, 8), password = 'T!9' + randomBytes(24).toString('base64url');
      await transaction.insert(users).values({ id: userId, username, nickname: kind === 'owner' ? 'e2e-admin' : 'e2e-' + kind, password: await bcrypt.hash(password, 12), role: kind === 'readonly' ? 'READ_ONLY' : 'SYSTEM_ADMIN', status: 'active', mustChangePassword: false, passwordChangedAt: new Date() });
      await transaction.insert(tenantMemberships).values({ tenantId, userId, defaultApplicationId: applicationId, status: 'active' });
      if (kind === 'owner') Object.assign(fixture, { userId, username, password });
      else fixture[kind] = { userId, username, password, tenantId, applicationId };
    }
    await transaction.insert(policyProfiles).values({ ...scope, id: policyId, name: '自动化测试基线策略', description: '合成规则，仅用于工程连通性验收', isDefault: true, isActive: true });
    const dimensionIds: Record<string, string> = {};
    for (const [index, dimension] of dimensions.entries()) {
      const id = randomUUID(); dimensionIds[dimension.code] = id;
      await transaction.insert(detectionDimensions).values({ ...scope, id, ...dimension, priority: index, enabled: true, isSystem: false });
      await transaction.insert(detectionRules).values({ ...scope, dimensionId: id, name: '自动化标记-' + dimension.code, type: 'keyword', pattern: 'AUTO_RISK_' + dimension.code, matchType: 'contains', score: '99.00', confidence: '0.99', priority: 1, enabled: true });
      await transaction.insert(policyDimensionConfig).values({ ...scope, policyId, dimensionId: id, enabled: true, warnThreshold: 50, blockThreshold: 80 });
      await transaction.insert(policyRules).values({ ...scope, policyId, dimension: dimension.code, enabled: true, warnThreshold: '50.00', blockThreshold: '80.00' });
    }
    fixture.dimensionIds = dimensionIds;
  });
  const bundle = await bootstrapLocalDefaultPolicyBundle(scope);
  fixture.bundleId = bundle.bundleId;
  writeFileSync(out + '/fixture.private.json', JSON.stringify(fixture));
  env.JUDGE_PRIVATE_ENDPOINT_APPROVALS_JSON = JSON.stringify([{...scope,baseUrl:'http://127.0.0.1:59091/v1',dataBoundaryPolicyId:'synthetic-full-test',approvalRef:'SYNTHETIC_TEST_ONLY_NOT_PRODUCTION'}]);
  env.RAG_PROVENANCE_KEY = randomBytes(48).toString('base64url');
  env.GUARDLLM_ENABLE_EXPERIMENTAL_LABS = 'true';
  writeFileSync(out + '/environment.private.json', JSON.stringify(env));
  writeFileSync(out + '/fixture-summary.json', JSON.stringify({ scope: 'SYNTHETIC_ONLY_NEW_EMPTY_DATABASE', dimensions: 16, rules: 16, users: 6, policyAssurance: bundle.assuranceLevel, externalApproval: false }, null, 2));
  console.log('SYNTHETIC_FULL_FIXTURE_READY');
}
main().finally(closeDatabaseConnection).catch(error => { console.error(error instanceof Error ? error.message.split('\n')[0].slice(0, 200) : 'PREPARE_FAILED'); process.exitCode = 1; });
