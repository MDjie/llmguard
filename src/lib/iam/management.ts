import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/storage/database/shared/db';
import { passwordHistory, tenantMemberships, users } from '@/storage/database/shared/schema';
import type { AuthenticatedPrincipal } from '@/lib/api-security/types';
import { appendAuditEventInTransaction } from '@/lib/audit/repository';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import { hashPassword, validatePasswordPolicy } from '@/lib/auth/password';
import { normalizePlatformRole } from '@/lib/auth/authorization';
import { requireTenantContext, type TenantContext } from '@/lib/tenancy/context';
import { createIamUserSchema, updateIamUserSchema, identitySchema, type iamUserListSchema } from '@/contracts/http/iam';
import { iamChangeRequests, iamIdentityProfiles, userApplicationMemberships } from './schema';
import { denied, listEffectiveApplications, validateAssignment, writeAssignment, type IamTransaction } from './grants';
import { independentDecision, isPrivilegedRole } from './policy';
import { iamDeploymentMode, isImplementationAdmin } from './deployment-mode';

const { password: omittedPassword, ...storedShape } = updateIamUserSchema.shape;
void omittedPassword;
const storedChangeSchema = z.object(storedShape).strict().extend({
  passwordHash: z.string().regex(/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/).optional(),
});
// Hashes in approval payloads never leave the server.
type StoredChange = z.infer<typeof storedChangeSchema>;
type User = typeof users.$inferSelect;

export function iamDigest(value: unknown): string {
  // Hash the JSON representation persisted by JSONB, including ISO timestamps.
  return createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest('hex');
}

export async function auditIam(tx: IamTransaction, scope: TenantContext, event: string, target: string, summary: unknown) {
  const eventId = randomUUID();
  const serialized=canonicalJson({deploymentMode:iamDeploymentMode(),summary});
  await appendAuditEventInTransaction(tx, {
    event, outcome: 'ALLOWED', status: 200, requestId: eventId, traceId: eventId,
    method: 'INTERNAL', path: '/iam/' + encodeURIComponent(target), latencyMs: 0,
    principalId: scope.principalId, tenantId: scope.tenantId, applicationId: scope.applicationId,
    queryString: serialized.length<=1000?serialized:canonicalJson({digest:iamDigest(summary),preview:serialized.slice(0,700)}),
  });
}

function publicUser(user: User) {
  return { id: user.id, username: user.username, nickname: user.nickname, email: user.email,
    phone: user.phone, avatar: user.avatar, role: normalizePlatformRole(user.role), status: user.status,
    department: user.department, description: user.description, lastLoginAt: user.lastLoginAt,
    mustChangePassword: user.mustChangePassword, tokenVersion: user.tokenVersion,
    createdAt: user.createdAt, updatedAt: user.updatedAt };
}

export async function assertManagedUser(tx: IamTransaction, scope: TenantContext, id: string) {
  const [user] = await tx.select().from(users).where(eq(users.id, id)).for('update');
  if (!user) throw denied('USER_NOT_FOUND', 404);
  const targetMemberships = await tx.select().from(tenantMemberships).where(eq(tenantMemberships.userId, id));
  if (!targetMemberships.some(row => row.tenantId === scope.tenantId)) throw denied('USER_NOT_FOUND', 404);
  // A global identity may only be changed by an administrator belonging to every affected tenant.
  const actorMemberships = await tx.select().from(tenantMemberships).where(and(
    eq(tenantMemberships.userId, scope.principalId), eq(tenantMemberships.status, 'active')));
  if (targetMemberships.some(target => !actorMemberships.some(actor => actor.tenantId === target.tenantId))) {
    throw denied('CROSS_TENANT_IDENTITY_CHANGE_DENIED');
  }
  const targetGrants=await tx.select().from(userApplicationMemberships).where(and(eq(userApplicationMemberships.userId,id),eq(userApplicationMemberships.status,'active')));
  const actorGrants=await tx.select().from(userApplicationMemberships).where(and(eq(userApplicationMemberships.userId,scope.principalId),eq(userApplicationMemberships.status,'active')));
  if(targetGrants.some(target=>!actorGrants.some(actor=>actor.tenantId===target.tenantId&&actor.applicationId===target.applicationId&&
    (!actor.expiresAt||actor.expiresAt>new Date()))))throw denied('CROSS_APPLICATION_IDENTITY_CHANGE_DENIED');
  return user;
}

async function writeIdentity(tx: IamTransaction, userId: string, identity: z.infer<typeof identitySchema>) {
  if (identity.loginMethod === 'oidc' && identity.issuer !== process.env.IAM_OIDC_ISSUER) throw denied('OIDC_ISSUER_NOT_CONFIGURED', 409);
  const values = { loginMethod: identity.loginMethod, issuer: identity.loginMethod === 'oidc' ? identity.issuer : null,
    subject: identity.loginMethod === 'oidc' ? identity.subject : null, emergencyUntil: null, updatedAt: new Date() };
  await tx.insert(iamIdentityProfiles).values({ userId, ...values }).onConflictDoUpdate({
    target: iamIdentityProfiles.userId, set: values,
  });
}

async function protectedPassword(password: string, username: string, email?: string | null) {
  const policy = validatePasswordPolicy(password, [username, email ?? '']);
  if (!policy.valid) throw denied('PASSWORD_POLICY_FAILED', 400);
  return hashPassword(password);
}

export async function listManagedUsers(principal: AuthenticatedPrincipal, query: z.infer<typeof iamUserListSchema>) {
  const scope = requireTenantContext(principal);
  const conditions = [
    sql`exists (select 1 from tenant_memberships m where m.user_id = ${users.id} and m.tenant_id = ${scope.tenantId})`,
    sql`not exists (select 1 from user_application_memberships target where target.user_id=${users.id} and target.status='active'
      and not exists(select 1 from user_application_memberships actor where actor.user_id=${scope.principalId}
        and actor.tenant_id=target.tenant_id and actor.application_id=target.application_id and actor.status='active'
        and (actor.expires_at is null or actor.expires_at>now())))`,
  ];
  if (query.keyword) {
    const keyword = '%' + query.keyword.replace(/[\\%_]/g, value => '\\' + value) + '%';
    conditions.push(sql`(${users.username} ilike ${keyword} or ${users.nickname} ilike ${keyword})`);
  }
  if (query.role) conditions.push(inArray(users.role, query.role === 'SYSTEM_ADMIN' ? ['SYSTEM_ADMIN','admin'] :
    query.role === 'BUSINESS_OPERATOR' ? ['BUSINESS_OPERATOR','user'] : [query.role]));
  if (query.status) conditions.push(eq(users.status, query.status));
  const [rows, totals] = await Promise.all([
    db.select().from(users).where(and(...conditions)).orderBy(desc(users.createdAt)).limit(query.pageSize).offset((query.page - 1) * query.pageSize),
    db.select({ count: sql<number>`count(*)::int` }).from(users).where(and(...conditions)),
  ]);
  const ids = rows.map(row => row.id);
  const [grants, profiles, memberships] = ids.length ? await Promise.all([
    db.select().from(userApplicationMemberships).where(and(inArray(userApplicationMemberships.userId, ids), eq(userApplicationMemberships.tenantId, scope.tenantId))),
    db.select().from(iamIdentityProfiles).where(inArray(iamIdentityProfiles.userId, ids)),
    db.select().from(tenantMemberships).where(and(inArray(tenantMemberships.userId, ids), eq(tenantMemberships.tenantId, scope.tenantId))),
  ]) : [[], [], []];
  return { success: true, data: { items: rows.map(row => ({
    ...publicUser(row), grants: grants.filter(grant => grant.userId === row.id),
    identity: profiles.find(profile => profile.userId === row.id) ?? null,
    defaultApplicationId: memberships.find(member => member.userId === row.id)?.defaultApplicationId ?? null,
  })), total: totals[0]?.count ?? 0, page: query.page, pageSize: query.pageSize } };
}

async function requestChange(tx: IamTransaction, scope: TenantContext, target: User, kind: string, payload: Record<string, unknown>, reason: string) {
  const [requester]=await tx.select().from(users).where(eq(users.id,scope.principalId)).for('share');
  if(!requester||requester.status!=='active')throw denied('IAM_REQUESTER_AUTHORITY_REVOKED');
  const granted=await tx.select().from(userApplicationMemberships).where(and(eq(userApplicationMemberships.userId,target.id),eq(userApplicationMemberships.tenantId,scope.tenantId)));
  const [identity]=await tx.select().from(iamIdentityProfiles).where(eq(iamIdentityProfiles.userId,target.id));
  const reviewPayload={...payload,reviewContext:{account:publicUser(target),grants:granted,identity}};
  const [request] = await tx.insert(iamChangeRequests).values({
    tenantId: scope.tenantId, applicationId: scope.applicationId, targetUserId: target.id, requesterId: scope.principalId,
    kind, payload:reviewPayload, payloadDigest: iamDigest(reviewPayload), expectedTokenVersion: target.tokenVersion, requesterTokenVersion:requester.tokenVersion, reason,
    expiresAt: new Date(Date.now() + (kind === 'EMERGENCY_ACCESS' ? 15 : 1440) * 60_000),
  }).returning();
  await auditIam(tx, scope, 'iam.change.request', target.id, { requestId: request.id, kind, payloadDigest: request.payloadDigest, reason });
  return request.id;
}

export async function createUserWithGrants(principal: AuthenticatedPrincipal, input: z.infer<typeof createIamUserSchema>) {
  const scope = requireTenantContext(principal);
  const password = input.password ? await protectedPassword(input.password, input.username, input.email) :
    await hashPassword(randomBytes(48).toString('base64url'));
  return db.transaction(async tx => {
    await validateAssignment(tx, scope, input.assignment);
    const [duplicate] = await tx.select({ id: users.id }).from(users).where(or(eq(users.username, input.username),
      input.email ? sql`lower(${users.email}) = lower(${input.email})` : undefined)).limit(1);
    if (duplicate) throw denied('USER_IDENTITY_CONFLICT', 409);
    const approvalRequired = isPrivilegedRole(input.role) && !isImplementationAdmin(principal);
    const [user] = await tx.insert(users).values({
      username: input.username, password, nickname: input.nickname ?? input.username, email: input.email ?? null,
      phone: input.phone ?? null, department: input.department ?? null, description: input.description ?? null,
      role: input.role, status: approvalRequired || input.identity.loginMethod === 'emergency' ? 'disabled' : 'active',
      mustChangePassword: input.identity.loginMethod === 'local', passwordChangedAt: new Date(), createdBy: scope.principalId,
    }).returning();
    await writeAssignment(tx, scope, user.id, input.assignment);
    await writeIdentity(tx, user.id, input.identity);
    await tx.insert(passwordHistory).values({ userId: user.id, passwordHash: password });
    await auditIam(tx, scope, 'iam.user.created', user.id, { role: user.role, status: user.status,
      assignmentDigest: iamDigest(input.assignment), loginMethod: input.identity.loginMethod, reason: input.reason });
    const requestId = approvalRequired && input.identity.loginMethod !== 'emergency' ?
      await requestChange(tx, scope, user, 'PRIVILEGED_ACTIVATION', { id: user.id, expectedTokenVersion: user.tokenVersion,
        status: 'active', reason: input.reason }, input.reason) : undefined;
    return { success: true, data: publicUser(user), approvalRequired: Boolean(requestId), requestId };
  });
}

async function applyUserChange(tx: IamTransaction, scope: TenantContext, current: User, change: StoredChange) {
  const [profile] = await tx.select().from(iamIdentityProfiles).where(eq(iamIdentityProfiles.userId, current.id));
  if(profile?.loginMethod==='emergency'&&change.identity&&change.identity.loginMethod!=='emergency')throw denied('EMERGENCY_IDENTITY_IMMUTABLE');
  if ((profile?.loginMethod === 'emergency' || change.identity?.loginMethod === 'emergency') && change.status === 'active') {
    throw denied('EMERGENCY_ACTIVATION_REQUIRES_TWO_APPROVERS');
  }
  if (change.assignment) {
    await validateAssignment(tx, scope, change.assignment);
    await writeAssignment(tx, scope, current.id, change.assignment);
  }
  if (change.identity) await writeIdentity(tx, current.id, change.identity);
  if (change.passwordHash) await tx.insert(passwordHistory).values({ userId: current.id, passwordHash: current.password });
  const nextRole = change.role ?? normalizePlatformRole(current.role);
  if (!nextRole) throw denied('ACCOUNT_ROLE_INVALID');
  // Serialize last-administrator checks across all administrative mutations.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('iam:last-system-admin',0))`);
  if (normalizePlatformRole(current.role) === 'SYSTEM_ADMIN' && current.status === 'active' &&
    (nextRole !== 'SYSTEM_ADMIN' || (change.status && change.status !== 'active'))) {
    const [other] = await tx.select({ id: users.id }).from(users).where(and(
      inArray(users.role, ['SYSTEM_ADMIN','admin']), eq(users.status,'active'), ne(users.id,current.id),
      sql`exists (select 1 from tenant_memberships m where m.user_id = ${users.id} and m.tenant_id = ${scope.tenantId} and m.status='active')`,
    )).limit(1);
    if (!other) throw denied('LAST_SYSTEM_ADMIN_PROTECTED',409);
  }
  const values: Partial<typeof users.$inferInsert> = {};
  for (const field of ['nickname','email','phone','department','description','role','status'] as const) {
    if (change[field] !== undefined) Object.assign(values, { [field]: change[field] });
  }
  if (change.passwordHash) Object.assign(values, { password: change.passwordHash, passwordChangedAt: new Date(),
    mustChangePassword: true, failedLoginCount: 0, lockedUntil: null });
  if (change.identity?.loginMethod === 'emergency') values.status = 'disabled';
  if (change.identity?.loginMethod === 'oidc') values.mustChangePassword = false;
  const [updated] = await tx.update(users).set({ ...values, tokenVersion: sql`${users.tokenVersion} + 1`, updatedAt: new Date() })
    .where(and(eq(users.id,current.id),eq(users.tokenVersion,change.expectedTokenVersion))).returning();
  if (!updated) throw denied('USER_VERSION_CONFLICT',409);
  await auditIam(tx, scope, 'iam.user.changed', current.id, { before: iamDigest(publicUser(current)),
    after: iamDigest(publicUser(updated)), changeDigest: iamDigest(change), reason: change.reason });
  return updated;
}

export async function changeManagedUser(principal: AuthenticatedPrincipal, input: z.infer<typeof updateIamUserSchema>) {
  const scope = requireTenantContext(principal);
  if (scope.principalId === input.id) throw denied('SELF_MANAGEMENT_DENIED');
  return db.transaction(async tx => {
    const current = await assertManagedUser(tx, scope, input.id);
    if (current.tokenVersion !== input.expectedTokenVersion) throw denied('USER_VERSION_CONFLICT',409);
    const { password, ...fields } = input;
    const passwordHash = password ? await protectedPassword(password, current.username, input.email ?? current.email) : undefined;
    const change: StoredChange = { ...fields, ...(passwordHash ? { passwordHash } : {}) };
    if (input.assignment) await validateAssignment(tx,scope,input.assignment);
    const sensitive = Boolean(input.role || input.assignment || input.identity || password || input.status);
    if (sensitive && !isImplementationAdmin(principal) && (isPrivilegedRole(normalizePlatformRole(current.role) ?? '') || isPrivilegedRole(input.role ?? ''))) {
      const requestId = await requestChange(tx,scope,current,'USER_CHANGE',change,input.reason);
      return { success: true, approvalRequired: true, requestId, data: publicUser(current) };
    }
    const updated = await applyUserChange(tx,scope,current,change);
    return { success: true, approvalRequired: false, data: publicUser(updated) };
  });
}

export async function listIamChanges(principal: AuthenticatedPrincipal) {
  const scope = requireTenantContext(principal);
  const canReview = principal.permissions.includes('iam:changes:approve') || principal.permissions.includes('iam:recovery:approve');
  const rows = await db.select({
    id: iamChangeRequests.id, kind: iamChangeRequests.kind, targetUserId: iamChangeRequests.targetUserId,
    requesterId: iamChangeRequests.requesterId, reason: iamChangeRequests.reason, status: iamChangeRequests.status,
    payloadDigest: iamChangeRequests.payloadDigest, payload: iamChangeRequests.payload, decisions: iamChangeRequests.decisions,
    expiresAt: iamChangeRequests.expiresAt, createdAt: iamChangeRequests.createdAt,
  }).from(iamChangeRequests).where(and(eq(iamChangeRequests.tenantId,scope.tenantId),
    eq(iamChangeRequests.applicationId,scope.applicationId),
    canReview ? undefined : eq(iamChangeRequests.requesterId,scope.principalId))).orderBy(desc(iamChangeRequests.createdAt)).limit(100);
  return { success: true, items: rows.map(({payload, ...row}) => {
    const {passwordHash, ...details} = payload;
    return {...row, details:{...details, ...(passwordHash ? {passwordReset:true} : {})},
      status:row.status==='pending' && row.expiresAt<=new Date() ? 'expired' : row.status};
  }) };
}

export async function decideIamChange(principal: AuthenticatedPrincipal, id: string, decision: 'approve' | 'reject') {
  const scope = requireTenantContext(principal);
  return db.transaction(async tx => {
    const [request] = await tx.select().from(iamChangeRequests).where(and(eq(iamChangeRequests.id,id),
      eq(iamChangeRequests.tenantId,scope.tenantId),eq(iamChangeRequests.applicationId,scope.applicationId))).for('update');
    if (!request || request.status !== 'pending' || request.expiresAt <= new Date()) throw denied('IAM_APPROVAL_NOT_PENDING',409);
    const recovery = request.kind === 'EMERGENCY_ACCESS';
    const [originalRequester]=await tx.select().from(users).where(eq(users.id,request.requesterId)).for('share');
    if(!originalRequester||originalRequester.status!=='active'||originalRequester.tokenVersion!==request.requesterTokenVersion)throw denied('IAM_REQUESTER_AUTHORITY_REVOKED');
    const [actor] = await tx.select().from(users).where(eq(users.id,scope.principalId)).for('share');
    if (!actor || actor.status !== 'active' || normalizePlatformRole(actor.role) !== principal.roles[0]) throw denied('IAM_REVIEWER_AUTHORITY_REVOKED');
    const implementationReview = !recovery && isImplementationAdmin(principal) && request.targetUserId !== scope.principalId;
    if (!principal.permissions.includes(recovery ? 'iam:recovery:approve' : 'iam:changes:approve') ||
      (!implementationReview && !independentDecision(request.requesterId,scope.principalId,request.targetUserId))) throw denied('IAM_INDEPENDENT_APPROVAL_REQUIRED');
    if (iamDigest(request.payload) !== request.payloadDigest) throw denied('IAM_APPROVAL_DIGEST_MISMATCH',409);
    const {reviewContext,...executionPayload}=request.payload;
    void reviewContext;
    if (request.decisions.some(item => item.actorId === scope.principalId)) throw denied('IAM_DUPLICATE_APPROVER',409);
    const role = principal.roles[0];
    if (!role || (recovery && request.decisions.some(item => item.role === role))) throw denied('IAM_DISTINCT_ROLES_REQUIRED');
    const current = await assertManagedUser(tx,scope,request.targetUserId);
    for (const previous of request.decisions) {
      const [reviewer] = await tx.select().from(users).where(eq(users.id,previous.actorId)).for('share');
      if (!reviewer || reviewer.status !== 'active' || normalizePlatformRole(reviewer.role) !== previous.role ||reviewer.tokenVersion!==previous.tokenVersion) throw denied('IAM_REVIEWER_AUTHORITY_REVOKED');
      await assertManagedUser(tx,{...scope,principalId:previous.actorId},current.id);
    }
    if (current.tokenVersion !== request.expectedTokenVersion) throw denied('USER_VERSION_CONFLICT',409);
    const decisions = [...request.decisions, { actorId: scope.principalId, role, tokenVersion:actor.tokenVersion, decision, at: new Date().toISOString() }];
    const status = decision === 'reject' ? 'rejected' : recovery && decisions.length < 2 ? 'pending' : 'approved';
    if (status === 'approved' && recovery) {
      const payload = z.object({ durationMinutes: z.number().int().min(5).max(60) }).strict().parse(executionPayload);
      const [profile] = await tx.select().from(iamIdentityProfiles).where(eq(iamIdentityProfiles.userId,current.id)).for('update');
      if (profile?.loginMethod !== 'emergency') throw denied('NOT_EMERGENCY_ACCOUNT');
      await tx.update(iamIdentityProfiles).set({ emergencyUntil: new Date(Date.now()+payload.durationMinutes*60_000), updatedAt: new Date() }).where(eq(iamIdentityProfiles.userId,current.id));
      await tx.update(users).set({ status:'active', tokenVersion:sql`${users.tokenVersion}+1` }).where(eq(users.id,current.id));
    } else if (status === 'approved') {
      // Re-check the original administrator's scope and version at execution, not only the reviewer's.
      const [requester] = await tx.select().from(users).where(and(eq(users.id,request.requesterId),eq(users.status,'active')));
      if (!requester || normalizePlatformRole(requester.role) !== 'SYSTEM_ADMIN') throw denied('IAM_REQUESTER_AUTHORITY_REVOKED');
      const effective = await listEffectiveApplications(request.requesterId,scope.tenantId);
      if (!effective.some(row=>row.app.id===scope.applicationId)) throw denied('IAM_REQUESTER_AUTHORITY_REVOKED');
      const change = storedChangeSchema.parse(executionPayload);
      const originalScope = { ...scope, principalId: request.requesterId };
      await assertManagedUser(tx,originalScope,current.id);
      await applyUserChange(tx,originalScope,current,change);
    }
    await tx.update(iamChangeRequests).set({ decisions, status, decidedAt: status === 'pending' ? null : new Date() }).where(eq(iamChangeRequests.id,id));
    await auditIam(tx,scope,recovery ? 'iam.emergency.decision' : 'iam.change.decision',request.targetUserId,
      { requestId:id, status, decision, payloadDigest:request.payloadDigest });
    return { success:true, status };
  });
}

export async function requestEmergencyAccess(principal: AuthenticatedPrincipal, targetUserId: string, reason: string, durationMinutes: number) {
  const scope = requireTenantContext(principal);
  if (targetUserId === scope.principalId) throw denied('SELF_RECOVERY_REQUEST_DENIED');
  return db.transaction(async tx => {
    const target = await assertManagedUser(tx,scope,targetUserId);
    const [profile] = await tx.select().from(iamIdentityProfiles).where(eq(iamIdentityProfiles.userId,target.id));
    if (profile?.loginMethod !== 'emergency') throw denied('NOT_EMERGENCY_ACCOUNT');
    const id = await requestChange(tx,scope,target,'EMERGENCY_ACCESS',{ durationMinutes },reason);
    return { success:true, requestId:id };
  });
}
