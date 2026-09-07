import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';

async function main() {
  const directory = resolve('.artifact-build/upgrade-implementation-20260907/environment');
  const environment: Record<string,string> = JSON.parse(readFileSync(resolve(directory, 'environment.json'), 'utf8'));
  Object.assign(process.env, environment);
  const parsed = new URL(environment.PGDATABASE_URL);
  if (parsed.hostname !== '127.0.0.1' || !parsed.pathname.startsWith('/guardllm_integration_')) throw new Error('ISOLATED_DATABASE_REQUIRED');
  const [{ db, closeDatabaseConnection }, schema, crypto, credentials] = await Promise.all([
    import('../../src/storage/database/shared/db'), import('../../src/storage/database/shared/schema'), import('../../src/lib/policy-bundle/crypto'), import('../../src/lib/tenancy/credentials'),
  ]);
  const tenantId = '8adf1bc0-508a-478d-af0c-10b53dcae001', applicationId = '8adf1bc0-508a-478d-af0c-10b53dcae002', policyId = '8adf1bc0-508a-478d-af0c-10b53dcae003', bundleId = '8adf1bc0-508a-478d-af0c-10b53dcae007';
  const templateText='请按照已批准的业务规范提供帮助。';
  const templateHash=createHash('sha256').update(templateText).digest('hex');
  const payload: import('../../src/lib/policy-bundle/types').CompiledPolicyBundle = {
    schemaVersion: '1.0', policyId, policyVersion: 4, dimensions: [{ id: 'pii', code: 'pii.mobile', name: '合成测试隐私', weight: 1 }, {id:'rewrite',code:'input.rewrite',name:'合成输入改写',weight:1}],
    rules: [{ id: 'integration-deny', riskType: 'prompt_injection', pattern: 'SYNTHETIC_BLOCK_MARKER', matchType: 'contains', caseSensitive: true, score: 1, mandatoryDeny: true },
      ...([
        ['input-rewrite','input.rewrite','INPUT_REWRITE_CASE','INPUT'],
        ['input-safe','output.sexual.low_vulgar','INPUT_SAFE_CASE','INPUT'],
        ['output-safe','output.sexual.low_vulgar','SYNTHETIC_SAFE_MARKER','OUTPUT_COMPLETE'],
        ['output-rewrite','output.insurance.guaranteed_return','SYNTHETIC_REWRITE_MARKER','OUTPUT_COMPLETE'],
        ['output-review','output.insurance.no_suitability','SYNTHETIC_REVIEW_MARKER','OUTPUT_COMPLETE'],
        ['output-warn','output.insurance.contextual','SYNTHETIC_WARN_MARKER','OUTPUT_COMPLETE'],
      ] as const).map(([id,riskType,pattern,direction])=>({id,riskType,pattern,direction,matchType:'contains' as const,caseSensitive:true,score:0.7})),
    ], exceptions: [],
    thresholds: [{ dimensionId: 'pii', warn: 0.5, block: 0.95, autoMask: true, autoRewrite: false },{dimensionId:'rewrite',warn:0.5,block:0.95,autoMask:false,autoRewrite:true}],
    responseTemplates:['input.rewrite','output.insurance.guaranteed_return'].map(riskCategory=>({id:riskCategory+'-approved',templateKey:'integration.'+riskCategory,riskCategory,action:'REWRITE' as const,templateText,locale:'zh-CN',industry:'general',templateScope:'TENANT' as const,allowedVariables:[],version:1,contentHash:templateHash,signatureDigest:templateHash,approvedBy:'integration-approver'})),
    detectorDag: { version: 'integration-rules-dlp', maximumCostUnits: 4, nodes: ['rules','structured-dlp','output-privacy-dlp'].map((detectorId) => ({ id: detectorId, detectorId, tier: 'L0', dependsOn: [], runCondition: 'ALWAYS', timeoutMs: 1500, maxAttempts: 1, costUnits: 1, failurePolicy: 'FAIL_CLOSED' })) },
  };
  const {parseCompiledPolicyBundlePayload}=await import('../../src/lib/policy-bundle/runtime');
  parseCompiledPolicyBundlePayload(payload);
  const signed = crypto.signPolicyBundle(payload, { privateKey: crypto.signingPrivateKey(), signingKeyId: 'integration-policy' });
  try {
    await db.insert(schema.tenants).values({ id: tenantId, code: 'gateway-integration', name: '隔离测试租户' }).onConflictDoNothing();
    await db.insert(schema.applications).values({ id: applicationId, tenantId, code: 'gateway-integration', name: '隔离测试应用', owner: 'integration', department: 'QA', environment: 'test', dataClass: 'internal', modelRoutes: ['test'], integrationState: 'CONFIGURED' }).onConflictDoNothing();
    await db.insert(schema.policyProfiles).values({ id: policyId, tenantId, applicationId, name: '隔离测试策略', isActive: true }).onConflictDoNothing();
    await db.insert(schema.policyBundles).values({ id: bundleId, tenantId, applicationId, policyId, version: 4, state: 'active', canonicalJson: JSON.parse(signed.canonicalJson), contentHash: signed.contentHash, signature: signed.signature, signingKeyId: signed.signingKeyId, createdBy: 'integration-builder', approvedBy: 'integration-approver', testedBy: 'integration-test', approvedAt: new Date(), testedAt: new Date() }).onConflictDoNothing();
    await db.insert(schema.applicationPolicyBindings).values({ tenantId, applicationId, activeBundleId: bundleId, generation: 4, updatedBy: 'integration' }).onConflictDoUpdate({target:[schema.applicationPolicyBindings.tenantId,schema.applicationPolicyBindings.applicationId],set:{activeBundleId:bundleId,generation:4,updatedBy:'integration'}});
    const key = credentials.createApplicationApiKey();
    const credentialId = randomUUID();
    await db.insert(schema.applicationCredentials).values({ id: credentialId, tenantId, applicationId, keyId: key.keyId, secretHash: key.secretHash, name: '隔离测试凭证', permissions: ['guard:use'], createdBy: 'integration' });
    await db.update(schema.applications).set({ modelRoutes: ['test'], status: 'active' }).where(eq(schema.applications.id, applicationId));
    writeFileSync(resolve(directory, 'fixture.json'), JSON.stringify({ tenantId, applicationId, policyId, bundleId, credentialId, apiKey: key.apiKey }, null, 2), { mode: 0o600 });
    console.log('Signed policy and application credential prepared in isolated database.');
  } finally { await closeDatabaseConnection(); }
}
main().catch((error: unknown) => { console.error('GATEWAY_FIXTURE_FAILED', error instanceof Error ? error.message : 'unknown'); process.exitCode = 1; });
