import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { applications, tenantMemberships, tenants } from '@/storage/database/shared/schema';
import { ApiProblem } from '@/lib/api-security/problem';
import { userApplicationMemberships } from './schema';
import { grantAllowsApplication, grantAttributesSchema, grantPurposes } from './policy';
import type { TenantContext } from '@/lib/tenancy/context';
import type { z } from 'zod';
import type { assignmentSchema } from '@/contracts/http/iam';

export type IamTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Assignment = z.infer<typeof assignmentSchema>;

export async function listEffectiveApplications(userId: string, tenantId?: string) {
  const now = new Date();
  const rows = await db.select({ app: applications, grant: userApplicationMemberships, defaultId: tenantMemberships.defaultApplicationId })
    .from(userApplicationMemberships)
    .innerJoin(applications, and(eq(applications.id, userApplicationMemberships.applicationId), eq(applications.tenantId, userApplicationMemberships.tenantId)))
    .innerJoin(tenants, eq(tenants.id, applications.tenantId))
    .innerJoin(tenantMemberships, and(eq(tenantMemberships.userId, userApplicationMemberships.userId), eq(tenantMemberships.tenantId, applications.tenantId)))
    .where(and(eq(userApplicationMemberships.userId, userId), eq(userApplicationMemberships.status, 'active'),
      eq(tenantMemberships.status, 'active'), eq(tenants.status, 'active'), eq(applications.status, 'active'),
      or(isNull(userApplicationMemberships.expiresAt), gt(userApplicationMemberships.expiresAt, now)),
      tenantId ? eq(applications.tenantId, tenantId) : undefined))
    .orderBy(asc(applications.tenantId), asc(applications.id));
  return rows.filter(row => grantAllowsApplication(row.grant.attributes, row.app));
}

export async function validateAssignment(tx: IamTransaction, scope: TenantContext, assignment: Assignment) {
  const now = new Date();
  const ids = assignment.grants.map(grant => grant.applicationId);
  if (new Set(ids).size !== ids.length || !ids.includes(assignment.defaultApplicationId)) throw denied('ASSIGNMENT_INVALID');
  // Lock the grant rows so revocation cannot race assignment validation.
  const actorGrants = await tx.select().from(userApplicationMemberships).where(and(
    eq(userApplicationMemberships.userId, scope.principalId), eq(userApplicationMemberships.tenantId, scope.tenantId),
    inArray(userApplicationMemberships.applicationId, ids), eq(userApplicationMemberships.status, 'active'),
    or(isNull(userApplicationMemberships.expiresAt), gt(userApplicationMemberships.expiresAt, now)),
  )).for('share');
  const apps = await tx.select().from(applications).where(and(eq(applications.tenantId, scope.tenantId),
    eq(applications.status, 'active'), inArray(applications.id, ids))).for('share');
  if (apps.length !== ids.length || actorGrants.length !== ids.length) throw denied('APPLICATION_GRANT_DENIED');
  for (const grant of assignment.grants) {
    const app = apps.find(row => row.id === grant.applicationId);
    const actor = actorGrants.find(row => row.applicationId === grant.applicationId);
    if (!app || !actor || !grantAllowsApplication(actor.attributes, app) || !grantAllowsApplication(grant.attributes, app) ||
      (grant.expiresAt && new Date(grant.expiresAt) <= now) ||
      (actor.expiresAt && (!grant.expiresAt || new Date(grant.expiresAt) > actor.expiresAt))) throw denied('APPLICATION_ATTRIBUTES_DENIED');
    const actorAttributes = grantAttributesSchema.parse(actor.attributes);
    if((grant.attributes.allowedPurposes??grantPurposes).some(purpose=>!(actorAttributes.allowedPurposes??grantPurposes).includes(purpose)) ||
      (actorAttributes.allowedDepartments?.length && (!grant.attributes.allowedDepartments?.length||
        grant.attributes.allowedDepartments.some(department=>!actorAttributes.allowedDepartments!.includes(department))))) throw denied('GRANT_ESCALATION_DENIED');
    const levels = ['public','internal','confidential','restricted'];
    if (grant.attributes.allowedEnvironments.some(value => !actorAttributes.allowedEnvironments.includes(value)) ||
      levels.indexOf(grant.attributes.maxDataClass) > levels.indexOf(actorAttributes.maxDataClass) ||
      grant.attributes.userGroupIds.some(value => !actorAttributes.userGroupIds.includes(value))) throw denied('GRANT_ESCALATION_DENIED');
  }
}

export async function writeAssignment(tx: IamTransaction, scope: TenantContext, userId: string, assignment: Assignment) {
  await tx.insert(tenantMemberships).values({ tenantId: scope.tenantId, userId, defaultApplicationId: assignment.defaultApplicationId, status: 'active' })
    .onConflictDoUpdate({ target: [tenantMemberships.tenantId, tenantMemberships.userId],
      set: { defaultApplicationId: assignment.defaultApplicationId, status: 'active' } });
  await tx.update(userApplicationMemberships).set({ status: 'revoked', revokedBy: scope.principalId, revokedAt: new Date(),
    version: sql`${userApplicationMemberships.version} + 1` })
    .where(and(eq(userApplicationMemberships.userId, userId), eq(userApplicationMemberships.tenantId, scope.tenantId)));
  for (const grant of assignment.grants) {
    const values = { attributes: grant.attributes, status: 'active', expiresAt: grant.expiresAt ? new Date(grant.expiresAt) : null,
      grantedBy: scope.principalId, grantedAt: new Date(), revokedAt: null, revokedBy: null };
    await tx.insert(userApplicationMemberships).values({ userId, tenantId: scope.tenantId, applicationId: grant.applicationId, ...values })
      .onConflictDoUpdate({ target: [userApplicationMemberships.userId, userApplicationMemberships.tenantId, userApplicationMemberships.applicationId],
        set: { ...values, version: sql`${userApplicationMemberships.version} + 1` } });
  }
}

export function denied(code: string, status = 403): ApiProblem {
  return new ApiProblem({ status, code, title: '账户授权操作未完成', detail: '权限、数据范围或记录状态不符合要求，请刷新后检查授权。' });
}
