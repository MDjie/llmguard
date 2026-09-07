import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { applicationPolicyBindings, applications, gatewayNodeAcks, gatewayRequests, gatewayRuntimePublications, gatewayRuntimeSnapshots } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';
import { loadVerifiedPolicyBundle } from '@/lib/policy-bundle/runtime';
import { appendAuditEventInTransaction } from '@/lib/audit/repository';
import { canonicalJson, GatewayError, sha256 } from './protocol';
import { gatewaySetting } from './settings';
import { signPayload, verifyPayload } from './security';
import { captureModelRouting } from './model-routing';
import { createRuntimeSnapshot, snapshotFromRow, type GatewayTransaction } from './snapshot-factory';
import { assertWindowPolicy } from './window-policy';

const roleNames = ['active', 'previous', 'canary', 'shadow'] as const;
type Binding = typeof applicationPolicyBindings.$inferSelect;
const referenceSchema = z.object({ snapshotId: z.string(), bundleId: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const manifestSchema = z.object({ version: z.literal('1.0'), publicationId: z.string().uuid(), tenantId: z.string(), applicationId: z.string(),
  bindingGeneration: z.number().int().nonnegative(), action: z.string(), actorId: z.string(), canaryPercent: z.number().int().min(0).max(100),
  targets: z.array(z.string()).min(1).max(1000), createdAt: z.iso.datetime(),
  snapshots: z.object({ active: referenceSchema.nullable(), previous: referenceSchema.nullable(), canary: referenceSchema.nullable(), shadow: referenceSchema.nullable() }).strict(),
}).strict();
function targets(): string[] {
  const entries = z.record(z.string(), z.object({ role: z.enum(['proxy', 'bff']), secret: z.string().min(32), certificateSha256: z.string().optional() }).strict())
    .parse(JSON.parse(gatewaySetting('GATEWAY_WORKLOAD_KEYS_JSON', 'GATEWAY_WORKLOAD_KEYS_FILE') ?? '{}'));
  const nodes = Object.entries(entries).filter(([, entry]) => entry.role === 'proxy').map(([node]) => node).sort();
  if (nodes.length < (process.env.NODE_ENV === 'production' ? 2 : 1) || nodes.length > 1000) throw new GatewayError('PUBLICATION_PROXY_TARGETS_REQUIRED', 503);
  return nodes;
}
function verifiedPublication(row: typeof gatewayRuntimePublications.$inferSelect) {
  const manifest = manifestSchema.parse(row.manifest);
  if (manifest.publicationId !== row.id || manifest.tenantId !== row.tenantId || manifest.applicationId !== row.applicationId || manifest.bindingGeneration !== row.bindingGeneration ||
    sha256(canonicalJson(manifest)) !== row.digest || new Set(manifest.targets).size !== manifest.targets.length) throw new GatewayError('PUBLICATION_BINDING_INVALID', 503);
  verifyPayload('gateway-publication-v1', manifest, row.keyId, row.signature); return manifest;
}
/** Binding pointers, complete signed snapshots and a durable publication message commit together. */
export async function synchronizeGatewayPublication(transaction: GatewayTransaction, scope: TenantScope, action: string, actorId: string, previous?: Binding) {
  if (process.env.GATEWAY_V2_ENABLED !== 'true') return null;
  const [application] = await transaction.select().from(applications).where(and(eq(applications.tenantId, scope.tenantId), eq(applications.id, scope.applicationId))).for('update');
  if (!application?.modelRoutes.length) return null; // Detection-only v1 applications have no model proxy routes.
  const [binding] = await transaction.select().from(applicationPolicyBindings).where(scopePredicate(applicationPolicyBindings, scope)).for('update');
  if (!binding) throw new GatewayError('PUBLICATION_BINDING_REQUIRED', 409);
  const [pending] = await transaction.select({ count: sql<number>`least(count(*),10001)::int` }).from(gatewayRuntimePublications).where(eq(gatewayRuntimePublications.dispatchState, 'PENDING'));
  if (pending.count >= 10000) throw new GatewayError('PUBLICATION_OUTBOX_CAPACITY', 503);
  const refs: z.infer<typeof manifestSchema>['snapshots'] = { active: null, previous: null, canary: null, shadow: null };
  const update: Partial<Binding> = {};
  for (const role of roleNames) {
    const bundleId = binding[`${role}BundleId`], column = `${role}SnapshotId` as const;
    if (!bundleId) { update[column] = null; continue; }
    const restore = role === 'active' && (action === 'rollback' || action === 'withdraw') && previous?.activeBundleId !== bundleId;
    let previousId = previous && roleNames.map(oldRole => previous[`${oldRole}BundleId`] === bundleId ? previous[`${oldRole}SnapshotId`] : null).find(Boolean);
    previousId ??= binding[column];
    if (restore && !previousId) throw new GatewayError('ROLLBACK_COMPLETE_SNAPSHOT_REQUIRED', 409);
    const bundle = await loadVerifiedPolicyBundle(scope, bundleId, { transaction });
    const [old] = previousId ? await transaction.select().from(gatewayRuntimeSnapshots).where(and(scopePredicate(gatewayRuntimeSnapshots, scope), eq(gatewayRuntimeSnapshots.id, previousId))).limit(1) : [];
    let snapshot = old && old.bundleId === bundleId ? snapshotFromRow(old) : null;
    if (snapshot) {
      verifyPayload('gateway-snapshot-v2', snapshot.manifest, snapshot.keyId, snapshot.signature);
      if (snapshot.digest !== sha256(canonicalJson(snapshot.manifest)) || snapshot.state === 'REVOKED' || snapshot.manifest.bundleDigest !== sha256(canonicalJson(bundle.payload))) throw new GatewayError('PUBLICATION_SNAPSHOT_INVALID', 503);
      if (restore && snapshot.manifest.validUntil <= Date.now()) throw new GatewayError('ROLLBACK_SNAPSHOT_EXPIRED', 409);
      if (role !== 'previous') {
        const current = captureModelRouting(application.modelRoutes, application.dataClass);
        if ((restore || action !== 'refresh') && (snapshot.manifest.modelRouting?.configurationDigest !== current.configurationDigest || snapshot.manifest.dataBoundary !== application.dataClass ||
          canonicalJson(snapshot.manifest.modelRoutes) !== canonicalJson(application.modelRoutes))) throw new GatewayError('PUBLISHED_CONFIGURATION_CHANGED_REQUIRES_REFRESH', 409);
        // Explicit refresh recaptures current qualification; renewal and rollback must retain valid old qualification.
        if (snapshot.manifest.streamMode === 'WINDOW' && (restore || action !== 'refresh')) assertWindowPolicy(snapshot.manifest);
      }
      if (!restore && role !== 'previous' && (snapshot.manifest.validUntil <= Date.now() || action === 'refresh')) snapshot = null;
    }
    if (!snapshot) snapshot = await createRuntimeSnapshot(transaction, scope, application, { ...bundle, generation: binding.generation });
    refs[role] = { snapshotId: snapshot.id, bundleId, digest: snapshot.digest }; update[column] = snapshot.id;
  }
  const id = randomUUID(), manifest = manifestSchema.parse({ version: '1.0', publicationId: id, tenantId: scope.tenantId, applicationId: scope.applicationId,
    bindingGeneration: binding.generation, action, actorId, canaryPercent: binding.canaryPercent, targets: targets(), createdAt: new Date().toISOString(), snapshots: refs });
  const signed = signPayload('gateway-publication-v1', manifest);
  await transaction.update(applicationPolicyBindings).set(update).where(scopePredicate(applicationPolicyBindings, scope));
  await transaction.insert(gatewayRuntimePublications).values({ id, tenantId: scope.tenantId, applicationId: scope.applicationId, bindingGeneration: binding.generation,
    manifest, digest: sha256(canonicalJson(manifest)), keyId: signed.keyId, signature: signed.signature });
  return { id, generation: binding.generation, state: 'CONTROL_SAVED' as const };
}

export async function refreshGatewayPublication(scope: TenantScope, actorId: string, expectedGeneration: number) {
  return db.transaction(async transaction => {
    const [before] = await transaction.select().from(applicationPolicyBindings).where(scopePredicate(applicationPolicyBindings, scope)).for('update');
    if (!before || before.generation !== expectedGeneration) throw new GatewayError('PUBLICATION_GENERATION_CONFLICT', 409);
    await transaction.update(applicationPolicyBindings).set({ generation: before.generation + 1, updatedAt: new Date(), updatedBy: actorId }).where(scopePredicate(applicationPolicyBindings, scope));
    const publication = await synchronizeGatewayPublication(transaction, scope, 'refresh', actorId, before);
    if (!publication) throw new GatewayError('GATEWAY_PUBLICATION_NOT_CONFIGURED', 409);
    return publication;
  });
}

/** A daily validity renewal may only retain the already published configuration. */
export async function renewGatewayPublication(scope: TenantScope, expectedGeneration: number) {
  return db.transaction(async transaction => {
    const [before] = await transaction.select().from(applicationPolicyBindings).where(scopePredicate(applicationPolicyBindings, scope)).for('update');
    if (!before) throw new GatewayError('PUBLICATION_BINDING_REQUIRED', 409);
    if (before.generation !== expectedGeneration) return; // Another request already renewed; caller reloads the pointer.
    await transaction.update(applicationPolicyBindings).set({ generation: before.generation + 1, updatedAt: new Date(), updatedBy: 'gateway-validity-renewal' }).where(scopePredicate(applicationPolicyBindings, scope));
    if (!await synchronizeGatewayPublication(transaction, scope, 'renew', 'gateway-validity-renewal', before)) throw new GatewayError('GATEWAY_PUBLICATION_NOT_CONFIGURED', 503);
  });
}

/** Announcing the durable publication is separate from a proxy loading or using it. */
export async function announceGatewayPublication(scope?: TenantScope) {
  return db.transaction(async transaction => {
    const [row] = await transaction.select().from(gatewayRuntimePublications).where(and(eq(gatewayRuntimePublications.dispatchState, 'PENDING'), scope ? scopePredicate(gatewayRuntimePublications, scope) : undefined))
      .orderBy(asc(gatewayRuntimePublications.createdAt)).limit(1).for('update', { skipLocked: true });
    if (!row) return null;
    const manifest = verifiedPublication(row);
    const audit = await appendAuditEventInTransaction(transaction, { tenantId: row.tenantId, applicationId: row.applicationId, principalId: manifest.actorId,
      event: 'gateway.runtime.publication', outcome: 'ALLOWED', status: 200, requestId: row.id, traceId: row.id, method: 'INTERNAL',
      path: '/api/gateway/publications', queryString: 'sha256=' + row.digest, latencyMs: 0 });
    await transaction.update(gatewayRuntimePublications).set({ dispatchState: 'ANNOUNCED', announcedAt: new Date(), auditEventId: audit.id }).where(eq(gatewayRuntimePublications.id, row.id));
    return { id: row.id, state: 'ANNOUNCED' as const };
  });
}
export async function listGatewayPublications(scope: TenantScope, limit = 20) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new GatewayError('PUBLICATION_QUERY_LIMIT_INVALID', 400);
  const rows = await db.select().from(gatewayRuntimePublications).where(scopePredicate(gatewayRuntimePublications, scope)).orderBy(desc(gatewayRuntimePublications.createdAt)).limit(limit);
  return Promise.all(rows.map(async row => {
    const manifest = verifiedPublication(row), references = [manifest.snapshots.active, manifest.snapshots.canary, manifest.snapshots.shadow].filter(ref => ref !== null);
    const ids = references.map(ref => ref.snapshotId);
    const acks = ids.length ? await db.select().from(gatewayNodeAcks).where(and(scopePredicate(gatewayNodeAcks, scope), inArray(gatewayNodeAcks.snapshotId, ids), inArray(gatewayNodeAcks.nodeId, manifest.targets))) : [];
    const nodes = manifest.targets.map(nodeId => ({ nodeId, loaded: references.length > 0 && references.every(ref => acks.some(ack => ack.nodeId === nodeId && ack.snapshotId === ref.snapshotId && ack.digest === ref.digest && ack.state === 'LOADED' && ack.lastSeenAt.getTime() > Date.now() - 300000)) }));
    const [used] = ids.length ? await db.select({ count: sql<number>`least(count(*),9007199254740991)::float8` }).from(gatewayRequests).where(and(scopePredicate(gatewayRequests, scope), inArray(gatewayRequests.snapshotId, ids),
      gte(gatewayRequests.createdAt, row.createdAt), sql`${gatewayRequests.stepCount} > 0`)) : [{ count: 0 }];
    return { id: row.id, generation: row.bindingGeneration, manifest, digest: row.digest, keyId: row.keyId, signature: row.signature,
      dispatchState: row.dispatchState, auditEventId: row.auditEventId, nodes, loadedNodes: nodes.filter(node => node.loaded).length,
      loadingState: nodes.every(node => node.loaded) ? 'ALL_TARGETS_LOADED' : nodes.some(node => node.loaded) ? 'PARTIALLY_LOADED' : 'AWAITING_LOAD', observedRequests: used.count };
  }));
}
