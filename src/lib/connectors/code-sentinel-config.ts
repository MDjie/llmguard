import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { artifacts, applications } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { gatewaySetting } from '@/lib/gateway-runtime/settings';
import { canonicalJson, sha256 } from '@/lib/gateway-runtime/protocol';
import { pinnedEndpointSchema, validatePinnedEndpoint } from './pinned-json';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const adaptersSchema = z.array(pinnedEndpointSchema.extend({ tenantId: z.string(), applicationId: z.string(), adapterId: z.string().min(1).max(128),
  engineVersion: z.string().min(1).max(128), ruleSetDigest: hash, languages: z.array(z.string().min(1).max(32)).min(1).max(50),
  riskIds: z.array(z.string().min(1).max(100)).min(1).max(100), allowedDataClasses: z.array(z.string().min(1)).min(1).max(10),
  maximumSourceBytes: z.number().int().min(1).max(1048576), expiresAt: z.number().int(),
}).strict()).max(1000);
export type Adapter = z.infer<typeof adaptersSchema>[number];
export function adapter(scope: TenantScope): Adapter {
  const entries = adaptersSchema.parse(JSON.parse(gatewaySetting('CODE_SENTINEL_ADAPTERS_JSON', 'CODE_SENTINEL_ADAPTERS_FILE') ?? '[]'));
  const selected = entries.filter(a => a.tenantId === scope.tenantId && a.applicationId === scope.applicationId);
  if (selected.length !== 1 || selected[0].expiresAt <= Date.now()) throw new Error('CODE_SENTINEL_ADAPTER_UNAVAILABLE');
  validatePinnedEndpoint(selected[0].endpoint); return selected[0];
}
export async function sourceBinding(scope: TenantScope, ownerId: string, artifactId: string, config: Adapter) {
  const [artifact] = await db.select().from(artifacts).where(and(scopePredicate(artifacts, scope), eq(artifacts.id, artifactId), eq(artifacts.ownerId, ownerId))).limit(1);
  const [application] = await db.select({ dataClass: applications.dataClass }).from(applications).where(and(eq(applications.tenantId, scope.tenantId), eq(applications.id, scope.applicationId), eq(applications.status, 'active'))).limit(1);
  const language = artifact?.metadata?.language;
  if (!artifact || artifact.kind !== 'TEXT' || artifact.state !== 'accepted' || artifact.contentExpiresAt <= new Date() || artifact.verifiedSize === null || artifact.verifiedSize > config.maximumSourceBytes || !artifact.verifiedSha256 || typeof language !== 'string' || !config.languages.includes(language)) throw new Error('CODE_SENTINEL_SOURCE_UNAVAILABLE');
  if (!application || !config.allowedDataClasses.includes(application.dataClass)) throw new Error('CODE_SENTINEL_DATA_BOUNDARY_DENIED');
  const bindingDigest = sha256(canonicalJson({ scope, ownerId, artifactId, language, sha256: artifact.verifiedSha256, bytes: artifact.verifiedSize, expiresAt: artifact.contentExpiresAt.getTime(), dataClass: application.dataClass }));
  return { artifact, language, bindingDigest };
}
export async function captureCodeScanBinding(scope: TenantScope, ownerId: string, artifactId: string) {
  const config = adapter(scope), source = await sourceBinding(scope, ownerId, artifactId, config);
  return { adapterId: config.adapterId, configurationDigest: sha256(canonicalJson(config)), artifactBindingDigest: source.bindingDigest };
}
