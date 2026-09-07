import { failGatewayPreparation } from './preparation';
import { admitGatewayResources, preparedGatewayResources } from './resources';
import { renewGatewayPublication } from './publication';
import { splitArtifactRequest, materializeArtifactRequest, assertArtifactContextActive, artifactContextProofSchema } from './artifact-context';
import { randomUUID } from 'node:crypto';
import { splitRagRequest, materializeRagRequest, assertRagContextActive, ragContextProofSchema } from './rag-context';
import { and, eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import type { AuthenticatedPrincipal } from '@/lib/api-security';
import { authenticateApplicationCredential } from '@/lib/tenancy/credentials';
import { resolveUserTenantScope } from '@/lib/tenancy/repository';
import { findUserById } from '@/lib/auth/repository';
import { normalizePlatformRole, permissionsForRole } from '@/lib/auth/authorization';
import { db } from '@/storage/database/shared/db';
import { applicationPolicyBindings, applications, applicationCredentials, gatewayRequests, gatewayRuntimeSnapshots, tenants } from '@/storage/database/shared/schema';
import { requireTenantContext, scopePredicate, type TenantScope } from '@/lib/tenancy';
import { loadRuntimePolicyBundle } from '@/lib/policy-bundle';
import { readSecureMemorySnapshot } from '@/lib/secure-memory';
import type { AuthContext, GatewayAuthorize, GatewayAuthorization, RuntimeSnapshot, SignedAuthContext } from '../../../packages/contracts/generated/typescript/gateway-v2';
import { canonicalJson, extractSegments, GatewayError, routingKey, sha256, type JsonValue } from './protocol';
import { evidenceHmac, issueAuthContext, openReceipt, sealReceipt, verifyAuthContext, verifyConsoleAssertion, verifyPayload } from './security';

import { createRuntimeSnapshot, snapshotFromRow, DEFAULT_GATEWAY_BUDGETS } from './snapshot-factory';
export { DEFAULT_GATEWAY_BUDGETS } from './snapshot-factory';

async function principalFor(body: GatewayAuthorize, request: NextRequest): Promise<AuthenticatedPrincipal> {
  const bearer = request.headers.get('authorization');
  const keyHeader = request.headers.get('x-guard-api-key');
  if (body.userAssertion) {
    if (bearer || keyHeader) throw new GatewayError('AMBIGUOUS_IDENTITY', 401);
    const assertion = verifyConsoleAssertion(body.userAssertion, body.requestDigest);
    const user = await findUserById(assertion.subject);
    const role = user && normalizePlatformRole(user.role);
    const scope = await resolveUserTenantScope(assertion.subject, assertion.tenantId, assertion.applicationId);
    if (!user || !role || !scope || user.status !== 'active' || user.tokenVersion !== assertion.tokenVersion || (user.lockedUntil && user.lockedUntil.getTime() > Date.now())) throw new GatewayError('CONSOLE_IDENTITY_REVOKED', 401);
    return { subject: user.id, ...scope, roles: [role], permissions: permissionsForRole(role, Boolean(user.mustChangePassword)), tokenVersion: user.tokenVersion, authenticationMethod: 'bearer' };
  }
  const bearerKey = bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined;
  if ((bearer && !bearerKey) || (bearerKey && keyHeader && bearerKey !== keyHeader)) throw new GatewayError('AMBIGUOUS_APPLICATION_CREDENTIAL', 401);
  const key = bearerKey ?? keyHeader;
  if (!key) throw new GatewayError('APPLICATION_CREDENTIAL_REQUIRED', 401);
  const synthetic = new NextRequest('http://gateway.internal/credential', { headers: { 'x-guard-api-key': key } });
  const principal = await authenticateApplicationCredential(synthetic);
  if (!principal) throw new GatewayError('APPLICATION_CREDENTIAL_INVALID', 401);
  return principal;
}

export async function readRuntimeSnapshot(scope: TenantScope, id: string): Promise<RuntimeSnapshot> {
  const [row] = await db.select().from(gatewayRuntimeSnapshots).where(and(scopePredicate(gatewayRuntimeSnapshots, scope), eq(gatewayRuntimeSnapshots.id, id))).limit(1);
  if (!row || row.state === 'REVOKED' || row.validUntil.getTime() <= Date.now()) throw new GatewayError('SNAPSHOT_UNAVAILABLE', 503);
  const snapshot = snapshotFromRow(row);
  if (snapshot.digest !== sha256(canonicalJson(snapshot.manifest))) throw new GatewayError('SNAPSHOT_DIGEST_INVALID', 503);
  verifyPayload('gateway-snapshot-v2', snapshot.manifest, snapshot.keyId, snapshot.signature);
  return snapshot;
}

async function snapshotFor(scope: TenantScope, application: typeof applications.$inferSelect, businessKey: string): Promise<RuntimeSnapshot> {
  const bundle = await loadRuntimePolicyBundle(scope, undefined, routingKey(scope.tenantId, scope.applicationId, businessKey));
  const [binding] = await db.select().from(applicationPolicyBindings).where(scopePredicate(applicationPolicyBindings, scope)).limit(1);
  let publishedId = binding?.activeBundleId === bundle.id ? binding.activeSnapshotId : binding?.canaryBundleId === bundle.id ? binding.canarySnapshotId : null;
  if (publishedId) {
    const [published] = await db.select({ validUntil: gatewayRuntimeSnapshots.validUntil }).from(gatewayRuntimeSnapshots).where(and(scopePredicate(gatewayRuntimeSnapshots, scope), eq(gatewayRuntimeSnapshots.id, publishedId))).limit(1);
    if (published && published.validUntil.getTime() <= Date.now()) {
      await renewGatewayPublication(scope, binding!.generation);
      const [renewed] = await db.select().from(applicationPolicyBindings).where(scopePredicate(applicationPolicyBindings, scope)).limit(1);
      publishedId = renewed?.activeBundleId === bundle.id ? renewed.activeSnapshotId : renewed?.canaryBundleId === bundle.id ? renewed.canarySnapshotId : null;
      if (!publishedId) throw new GatewayError('PUBLICATION_CHANGED_DURING_AUTHORIZATION', 409);
    }
    const snapshot = await readRuntimeSnapshot(scope, publishedId);
    if (snapshot.manifest.bundleId !== bundle.id || snapshot.manifest.bundleDigest !== sha256(canonicalJson(bundle.payload)) || snapshot.manifest.dataBoundary !== application.dataClass || canonicalJson(snapshot.manifest.modelRoutes) !== canonicalJson(application.modelRoutes)) throw new GatewayError('PUBLISHED_SNAPSHOT_BINDING_CHANGED', 503);
    return snapshot;
  }
  return db.transaction(tx => createRuntimeSnapshot(tx, scope, application, bundle));
}

export async function authorizeGateway(body: GatewayAuthorize, request: NextRequest): Promise<GatewayAuthorization> {
  const now = Date.now();
  if (body.deadline <= now || body.deadline > now + DEFAULT_GATEWAY_BUDGETS.absoluteTimeoutMs) throw new GatewayError('DEADLINE_INVALID', 400);
  let json: JsonValue;
  try { json = JSON.parse(body.requestJson); } catch { throw new GatewayError('REQUEST_JSON_INVALID', 400); }
  if (sha256(canonicalJson(json)) !== body.requestDigest) throw new GatewayError('REQUEST_DIGEST_MISMATCH', 400);
  const splitRag = splitRagRequest(json);
  const { request: sourceRequest, references } = splitArtifactRequest(splitRag.request);
  const rag = splitRag.rag;
  let inputSegments = extractSegments(sourceRequest, 'INPUT', DEFAULT_GATEWAY_BUDGETS.maxInputChars);
  if (!json || typeof json !== 'object' || Array.isArray(json) || json.model !== body.modelRoute) throw new GatewayError('MODEL_ROUTE_BINDING_MISMATCH', 403);
  const principal = await principalFor(body, request);
  if (!principal.permissions.includes('guard:use')) throw new GatewayError('GUARD_PERMISSION_REQUIRED', 403);
  const tenant = requireTenantContext(principal);
  const scope: TenantScope = { tenantId: tenant.tenantId, applicationId: tenant.applicationId };
  const [application] = await db.select().from(applications).where(and(eq(applications.id, scope.applicationId), eq(applications.tenantId, scope.tenantId), eq(applications.status, 'active'))).limit(1);
  if (!application || !application.modelRoutes.includes(body.modelRoute)) throw new GatewayError('MODEL_ROUTE_NOT_AUTHORIZED', 403);
  const idempotencyKey = body.idempotencyKey;
  const consoleAssertionHmac = body.userAssertion ? evidenceHmac(body.userAssertion) : undefined;
  const identity = { subject: principal.subject, tokenVersion: principal.tokenVersion ?? 0, authVersion: application.authVersion, requestDigest: body.requestDigest, sessionId: body.sessionId ?? null, modelRoute: body.modelRoute };
  const requestHmac = evidenceHmac(canonicalJson(identity));
  const [prior] = await db.select().from(gatewayRequests).where(and(scopePredicate(gatewayRequests, scope), eq(gatewayRequests.idempotencyKey, idempotencyKey))).limit(1);
  if (prior) {
    if (prior.requestHmac !== requestHmac) throw new GatewayError('IDEMPOTENCY_CONTENT_CONFLICT', 409);
    // A fresh authorization must never start the model again, including expired/tombstoned responses.
    throw new GatewayError('IDEMPOTENCY_' + prior.state, 409);
  }
  const snapshot = await snapshotFor(scope, application, body.sessionId ?? body.businessRequestId);
  const context: AuthContext = { contractVersion: '2.0', authContextId: randomUUID(), issuer: 'guard-control', audience: 'guard-gateway', keyId: process.env.GATEWAY_AUTH_KEY_ID ?? '',
    issuedAt: now, expiresAt: Math.min(body.deadline, snapshot.manifest.validUntil), ...scope, subjectId: principal.subject,
    ...(principal.authenticationMethod === 'service' ? { credentialId: principal.subject.replace('application-credential:', '') } : { subjectVersion: principal.tokenVersion ?? 0 }),
    authVersion: application.authVersion, businessRequestId: body.businessRequestId, traceId: body.traceId, ...(body.sessionId ? { sessionId: body.sessionId } : {}), requestDigest: body.requestDigest,
    policy: { snapshotId: snapshot.id, bundleId: snapshot.manifest.bundleId, generation: snapshot.manifest.generation, digest: snapshot.digest },
    allowedModelRoutes: application.modelRoutes, permissions: principal.permissions, dataBoundary: application.dataClass, deadline: body.deadline };
  // Shadow execution is opt-in; the approved reference is frozen once with the business request.
  const shadowBinding = process.env.GATEWAY_SHADOW_EVALUATION_ENABLED === 'true'
    ? (await db.select({ activeBundleId: applicationPolicyBindings.activeBundleId, canaryBundleId: applicationPolicyBindings.canaryBundleId, shadowSnapshotId: applicationPolicyBindings.shadowSnapshotId }).from(applicationPolicyBindings).where(scopePredicate(applicationPolicyBindings, scope)).limit(1))[0] : undefined;
  const shadowSnapshotId = shadowBinding && [shadowBinding.activeBundleId, shadowBinding.canaryBundleId].includes(snapshot.manifest.bundleId) ? shadowBinding.shadowSnapshotId : null;
  const provisionalAuth = issueAuthContext(context);
  try {
    await db.transaction(async (tx) => {
      if (body.sessionId) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope.tenantId + ':' + scope.applicationId + ':' + body.sessionId + ':gateway-session'}, 0))`);
        const [lease] = await tx.select({ id: gatewayRequests.id }).from(gatewayRequests).where(and(scopePredicate(gatewayRequests, scope), eq(gatewayRequests.sessionId, body.sessionId), eq(gatewayRequests.sessionFinalized, false))).limit(1);
        if (lease) throw new GatewayError('SESSION_REQUEST_IN_PROGRESS', 409);
      }
      await tx.insert(gatewayRequests).values({ id: body.businessRequestId, ...scope, idempotencyKey, requestHmac, snapshotId: snapshot.id, subjectId: principal.subject,
      sessionId: body.sessionId, shadowSnapshotId, state: 'AUTHORIZED', preparationState: 'PREPARING', authContext: provisionalAuth, expiresAt: new Date(body.deadline), consoleAssertionHmac });
      await admitGatewayResources(tx, { ...scope, requestId: body.businessRequestId, snapshotId: snapshot.id, budgets: snapshot.manifest.budgets,
        expiresAt: body.deadline, references: (rag ? 20 : 0) + (references?.length ?? 0) });
    });
  } catch (error) {
    const code = error && typeof error === 'object' && 'cause' in error && error.cause && typeof error.cause === 'object' && 'code' in error.cause ? error.cause.code : undefined;
    if (code === '23505') throw new GatewayError('REQUEST_OR_SESSION_CONFLICT', 409);
    throw error;
  }
  // The durable claim and admission precede reference reads; no database transaction spans I/O.
  try {
    request.signal.throwIfAborted();
    const memory = body.sessionId ? await readSecureMemorySnapshot(scope, body.sessionId) : undefined;
  const preparedRag = rag ? await materializeRagRequest({ request: sourceRequest, options: rag, scope, principal, requestId: body.businessRequestId, traceId: body.traceId, bundleId: snapshot.manifest.bundleId, deadline: body.deadline, maxInputChars: snapshot.manifest.budgets.maxInputChars, signal: request.signal }) : undefined;
  const preparedArtifacts = references ? await materializeArtifactRequest({ ...scope, subjectId: principal.subject, requestId: body.businessRequestId, bundleId: snapshot.manifest.bundleId,
    request: preparedRag?.request ?? sourceRequest, sourceSegments: preparedRag?.segments ?? inputSegments, references, deadline: body.deadline, maxInputChars: snapshot.manifest.budgets.maxInputChars, signal: request.signal }) : undefined;
  const prepared = preparedArtifacts ?? preparedRag;
  if (prepared) inputSegments = prepared.segments;
    request.signal.throwIfAborted();
    if (Date.now() >= context.expiresAt) throw new GatewayError('REQUEST_PREPARATION_EXPIRED', 408);
    const auth = issueAuthContext({ ...context, ...(prepared ? { preparedRequestDigest: sha256(canonicalJson(prepared.request)), inputSegmentsDigest: sha256(canonicalJson(inputSegments)) } : {}) });
    await db.transaction(async tx => {
      const [claimed] = await tx.select().from(gatewayRequests).where(and(scopePredicate(gatewayRequests, scope), eq(gatewayRequests.id, body.businessRequestId))).for('update');
      if (!claimed || claimed.preparationState !== 'PREPARING' || claimed.state !== 'AUTHORIZED' || claimed.expiresAt.getTime() <= Date.now()) throw new GatewayError('REQUEST_PREPARATION_CLOSED', 409);
      await preparedGatewayResources(tx, scope, body.businessRequestId, inputSegments.reduce((sum, segment) => sum + segment.text.length, 0), (preparedRag?.proof.manifest.sourceReferences.length ?? 0) + (preparedArtifacts?.proof.manifest.references.length ?? 0));
      await tx.update(gatewayRequests).set({ authContext: auth, preparationState: 'READY', sessionSnapshot: sealReceipt({ inputSegments, ...(preparedRag ? { ragContextProof: preparedRag.proof } : {}), ...(preparedArtifacts ? { artifactContextProof: preparedArtifacts.proof } : {}), ...(memory ? { memory } : {}) }, body.businessRequestId + ':memory') }).where(eq(gatewayRequests.id, body.businessRequestId));
    });
    return { auth, snapshot, replayState: 'NEW', ...(prepared ? { preparedRequestJson: canonicalJson(prepared.request), inputSegments } : {}) };
  } catch (error) {
    await failGatewayPreparation(scope, body.businessRequestId, provisionalAuth.signature).catch(() => console.error('GATEWAY_PREPARATION_RECONCILIATION_REQUIRED'));
    throw error;
  }
}

/** Revalidate revocation at every inspection and release point; do not rerun policy selection. */
export async function validateActiveContext(value: SignedAuthContext): Promise<{ auth: SignedAuthContext; snapshot: RuntimeSnapshot; row: typeof gatewayRequests.$inferSelect }> {
  const auth = verifyAuthContext(value); const context = auth.context;
  const [application] = await db.select({ authVersion: applications.authVersion }).from(applications).innerJoin(tenants, eq(tenants.id, applications.tenantId))
    .where(and(eq(applications.tenantId, context.tenantId), eq(applications.id, context.applicationId), eq(applications.status, 'active'), eq(tenants.status, 'active'))).limit(1);
  if (!application || application.authVersion !== context.authVersion) throw new GatewayError('APPLICATION_AUTHORIZATION_REVOKED', 401);
  let roles: readonly string[];
  if (context.credentialId) {
    roles = ['APP_DEVELOPER'];
    const [credential] = await db.select().from(applicationCredentials).where(and(scopePredicate(applicationCredentials, context), eq(applicationCredentials.id, context.credentialId))).limit(1);
    if (!credential || credential.revokedAt || (credential.expiresAt && credential.expiresAt.getTime() <= Date.now()) || !credential.permissions.includes('guard:use')) throw new GatewayError('CREDENTIAL_REVOKED', 401);
  } else {
    const user = await findUserById(context.subjectId); const role = user && normalizePlatformRole(user.role);
    const membership = await resolveUserTenantScope(context.subjectId, context.tenantId, context.applicationId);
    if (!user || !role || !membership || user.status !== 'active' || (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) || user.tokenVersion !== context.subjectVersion || !permissionsForRole(role, Boolean(user.mustChangePassword)).includes('guard:use')) throw new GatewayError('SUBJECT_REVOKED', 401);
    roles = [role];
  }
  const [row] = await db.select().from(gatewayRequests).where(and(scopePredicate(gatewayRequests, context), eq(gatewayRequests.id, context.businessRequestId))).limit(1);
  if (!row || row.authContext.signature !== auth.signature || row.snapshotId !== context.policy.snapshotId) throw new GatewayError('AUTH_CONTEXT_REQUEST_MISMATCH', 403);
  if (row.preparationState !== 'READY') throw new GatewayError('REQUEST_NOT_PREPARED', 409);
  if (context.preparedRequestDigest || context.inputSegmentsDigest) {
    if (!row.sessionSnapshot || !context.preparedRequestDigest || !context.inputSegmentsDigest) throw new GatewayError('PREPARED_REQUEST_BINDING_INVALID', 403);
    const processing = openReceipt(row.sessionSnapshot, row.id + ':memory') as { inputSegments: unknown; ragContextProof?: unknown; artifactContextProof?: unknown };
    if (sha256(canonicalJson(processing.inputSegments)) !== context.inputSegmentsDigest) throw new GatewayError('PREPARED_REQUEST_BINDING_INVALID', 403);
    if (!processing.ragContextProof && !processing.artifactContextProof) throw new GatewayError('PREPARED_REFERENCE_PROOF_REQUIRED', 403);
    if (processing.ragContextProof) await assertRagContextActive(ragContextProofSchema.parse(processing.ragContextProof), { ...context, roles, requestId: row.id, bundleId: context.policy.bundleId });
    if (processing.artifactContextProof) await assertArtifactContextActive(artifactContextProofSchema.parse(processing.artifactContextProof), { ...context, requestId: row.id, bundleId: context.policy.bundleId });
  }
  const snapshot = await readRuntimeSnapshot(context, row.snapshotId);
  if (snapshot.digest !== context.policy.digest || snapshot.manifest.bundleId !== context.policy.bundleId || snapshot.manifest.generation !== context.policy.generation) throw new GatewayError('SNAPSHOT_BINDING_MISMATCH', 403);
  return { auth, snapshot, row };
}
