import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

async function main() {
  const directory = path.resolve('.artifact-build/upgrade-implementation-20260907/environment');
  const environment: Record<string, string> = JSON.parse(readFileSync(path.join(directory, 'environment.json'), 'utf8'));
  const fixture: { tenantId: string; applicationId: string; credentialId: string } = JSON.parse(readFileSync(path.join(directory, 'fixture.json'), 'utf8'));
  const url = new URL(environment.PGDATABASE_URL);
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/guardllm_integration_gateway_v2') throw new Error('ISOLATED_DATABASE_REQUIRED');
  Object.assign(process.env, environment);
  const [{ db, closeDatabaseConnection }, schema, { ragContentHash, signRagProvenance }] = await Promise.all([
    import('../../src/storage/database/shared/db'), import('../../src/storage/database/shared/schema'), import('../../src/lib/rag/provenance'),
  ]);
  Object.assign(environment, { RAG_PROVENANCE_KEY: randomBytes(32).toString('hex'), OBJECT_STORE_ENDPOINT: 'http://127.0.0.1:58089', OBJECT_STORE_BUCKET: 'isolated',
    OBJECT_STORE_ALLOWED_PRIVATE_HOSTS: '127.0.0.1', OBJECT_STORE_ACCESS_KEY_ID: 'isolated-rag-model', OBJECT_STORE_SECRET_ACCESS_KEY: randomBytes(32).toString('hex') });
  Object.assign(process.env, environment);
  const scope = { tenantId: fixture.tenantId, applicationId: fixture.applicationId }, principalId = 'application-credential:' + fixture.credentialId;
  const objects: Record<string, string> = {}, sources: Record<string, { sourceId: string; artifactId: string; chunkId: string; objectKey: string; text: string }> = {};
  try {
    for (const [name, text, accessible] of [
      ['approved', '合成资料：服务窗口为工作日九点至十七点。', true],
      ['revocable', '合成资料：查询事项应携带业务编号。', true],
      ['denied', '其他主体的合成受限资料。', false],
      ['injection', 'SYNTHETIC_BLOCK_MARKER', true],
      ['tampered', '完整性验证的原始合成资料。', true],
    ] as const) {
      const sourceId = randomUUID(), artifactId = randomUUID(), chunkId = randomUUID(), objectKey = artifactId + '/part1';
      const hash = ragContentHash(text), size = Buffer.byteLength(text), validUntilEpochMs = Date.now() + 86400000;
      const allowedPrincipals = [accessible ? principalId : 'another-principal'], allowedRoles = ['APP_DEVELOPER'];
      await db.insert(schema.artifacts).values({ ...scope, id: artifactId, ownerId: principalId, kind: 'RAG_CHUNK', fileName: 'synthetic.txt', declaredMediaType: 'text/plain', declaredSize: size, verifiedSize: size,
        declaredSha256: hash, verifiedSha256: hash, objectPrefix: artifactId, state: 'accepted', idempotencyKey: randomUUID(), requestHash: hash, partSize: 16777216, partCount: 1, contentExpiresAt: new Date(validUntilEpochMs) });
      await db.insert(schema.artifactParts).values({ ...scope, artifactId, partNumber: 1, sizeBytes: size, sha256: hash, objectKey, state: 'verified', verifiedAt: new Date() });
      await db.insert(schema.ragSources).values({ ...scope, id: sourceId, artifactId, sourceUriHash: hash, sourceType: 'document', trustLevel: 80, classification: 3, acl: { allowedPrincipals, allowedRoles }, state: 'accepted' });
      const provenance = { ...scope, sourceId, chunkId, contentHash: hash, trustLevel: 80, classification: 3, allowedPrincipals, allowedRoles, state: 'accepted' as const, sourceVersion: hash, validUntilEpochMs };
      await db.insert(schema.ragChunks).values({ ...scope, id: chunkId, sourceId, artifactId, externalChunkId: chunkId, contentHash: hash, provenanceSignature: signRagProvenance(provenance), riskAction: 'ALLOW', riskScore: 0,
        state: 'accepted', metadata: { sourceVersion: hash, validUntilEpochMs } });
      objects[objectKey] = name === 'tampered' ? '对象存储中的合成篡改内容。' : text;
      sources[name] = { sourceId, artifactId, chunkId, objectKey, text };
    }
    writeFileSync(path.join(directory, 'rag-model-fixture.json'), JSON.stringify({ sources, principalId }, null, 2));
    writeFileSync(path.join(directory, 'rag-model-objects.json'), JSON.stringify(objects, null, 2));
    writeFileSync(path.join(directory, 'environment.json'), JSON.stringify(environment, null, 2));
    console.log('Prepared isolated RAG model-call fixtures; restart isolated control and launch the loopback object receiver.');
  } finally { await closeDatabaseConnection(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'RAG_MODEL_FIXTURE_FAILED'); process.exitCode = 1; });
