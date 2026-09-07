import { and, desc, eq, sql } from 'drizzle-orm';
import type { db } from '@/storage/database/shared/db';
import { applications, gatewayRuntimeSnapshots } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import type { RuntimePolicyBundle } from '@/lib/policy-bundle/runtime';
import { runtimeSnapshotSchema } from '@/contracts/http/gateway-v2';
import type { RuntimeManifest, RuntimeSnapshot } from '../../../packages/contracts/generated/typescript/gateway-v2';
import { captureWindowPolicy } from './window-policy';
import { captureModelRouting } from './model-routing';
import { canonicalJson, GatewayError, sha256 } from './protocol';
import { signPayload } from './security';
export type GatewayTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const DEFAULT_GATEWAY_BUDGETS = { maxInputChars: 131072, maxOutputChars: 262144, maxSteps: 512, maxEvents: 4096, maxStreamEvents: 16384, idleTimeoutMs: 15000, absoluteTimeoutMs: 60000 } as const;
export function snapshotFromRow(row: typeof gatewayRuntimeSnapshots.$inferSelect): RuntimeSnapshot {
  return runtimeSnapshotSchema.parse({ id: row.id, manifest: row.manifest, digest: row.digest, signature: row.signature, keyId: row.keyId, state: row.state });
}
/** Used by request bootstrap and policy publication; no model/network call occurs inside this transaction. */
export async function createRuntimeSnapshot(tx: GatewayTransaction, scope: TenantScope, application: typeof applications.$inferSelect, bundle: RuntimePolicyBundle, now = Date.now()): Promise<RuntimeSnapshot> {
  const windowPolicy = captureWindowPolicy(scope, application.dataClass, bundle.payload, now);
  const validUntil = Math.min((Math.floor(now / 86400000) + 1) * 86400000, windowPolicy?.qualificationExpiresAt ?? Number.MAX_SAFE_INTEGER);
  const modelRouting = captureModelRouting(application.modelRoutes, application.dataClass);
  const seed = { tenantId: scope.tenantId, applicationId: scope.applicationId, ...(windowPolicy ? { windowPolicy } : {}), modelRouting, authVersion: application.authVersion,
    bindingGeneration: bundle.generation, bundleId: bundle.id, bundleDigest: sha256(canonicalJson(bundle.payload)), modelRoutes: application.modelRoutes,
    dataBoundary: application.dataClass, validUntil, budgets: DEFAULT_GATEWAY_BUDGETS };
  const snapshotId = 'snap_' + sha256(canonicalJson(seed));
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope.tenantId + ':' + scope.applicationId + ':snapshot'}, 0))`);
  const [existing] = await tx.select().from(gatewayRuntimeSnapshots).where(and(scopePredicate(gatewayRuntimeSnapshots, scope), eq(gatewayRuntimeSnapshots.id, snapshotId))).limit(1);
  if (existing) { if (existing.state === 'REVOKED') throw new GatewayError('SNAPSHOT_REVOKED', 503); return snapshotFromRow(existing); }
  const [previous] = await tx.select({ generation: gatewayRuntimeSnapshots.generation }).from(gatewayRuntimeSnapshots).where(scopePredicate(gatewayRuntimeSnapshots, scope)).orderBy(desc(gatewayRuntimeSnapshots.generation)).limit(1);
  const manifest: RuntimeManifest = { tenantId: scope.tenantId, applicationId: scope.applicationId, modelRouting, generation: (previous?.generation ?? 0) + 1,
    bundleId: bundle.id, bundleDigest: seed.bundleDigest, modelRoutes: application.modelRoutes, dataBoundary: application.dataClass,
    streamMode: windowPolicy ? 'WINDOW' : 'FULL_BUFFER', windowQualified: Boolean(windowPolicy), holdbackChars: windowPolicy?.holdbackChars ?? 256,
    ...(windowPolicy ? { windowPolicy } : {}), budgets: DEFAULT_GATEWAY_BUDGETS, validUntil, normalizationVersion: 'guard-canonical-v2' };
  const signed = signPayload('gateway-snapshot-v2', manifest);
  const [row] = await tx.insert(gatewayRuntimeSnapshots).values({ id: snapshotId, tenantId: scope.tenantId, applicationId: scope.applicationId, generation: manifest.generation,
    bundleId: bundle.id, manifest, digest: sha256(canonicalJson(manifest)), signature: signed.signature, keyId: signed.keyId, state: 'PREPARED', validUntil: new Date(validUntil) }).returning();
  return snapshotFromRow(row);
}
