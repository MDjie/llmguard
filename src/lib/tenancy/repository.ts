import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import {
  applicationCredentials,
  applications,
  tenantMemberships,
  tenants,
} from '@/storage/database/shared/schema';
import type { TenantScope } from './context';

export interface ApplicationCredentialRecord extends TenantScope {
  readonly id: string;
  readonly keyId: string;
  readonly secretHash: string;
  readonly permissions: readonly string[];
}

export async function resolveUserTenantScope(
  userId: string,
  requestedTenantId?: string,
  requestedApplicationId?: string,
): Promise<TenantScope | null> {
  const membershipConditions = [
    eq(tenantMemberships.userId, userId),
    eq(tenantMemberships.status, 'active'),
    eq(tenants.status, 'active'),
    eq(applications.status, 'active'),
  ];
  if (requestedTenantId) membershipConditions.push(eq(tenantMemberships.tenantId, requestedTenantId));
  if (requestedApplicationId) membershipConditions.push(eq(applications.id, requestedApplicationId));

  const applicationJoin = and(
    eq(applications.tenantId, tenantMemberships.tenantId),
    requestedApplicationId
      ? eq(applications.id, requestedApplicationId)
      : eq(applications.id, tenantMemberships.defaultApplicationId),
  );

  const [scope] = await db
    .select({
      tenantId: tenantMemberships.tenantId,
      applicationId: applications.id,
    })
    .from(tenantMemberships)
    .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
    .innerJoin(applications, applicationJoin)
    .where(and(...membershipConditions))
    .limit(1);

  return scope ?? null;
}

export async function findActiveApplicationCredential(
  keyId: string,
  now: Date,
): Promise<ApplicationCredentialRecord | null> {
  const [credential] = await db
    .select({
      id: applicationCredentials.id,
      keyId: applicationCredentials.keyId,
      secretHash: applicationCredentials.secretHash,
      permissions: applicationCredentials.permissions,
      tenantId: applicationCredentials.tenantId,
      applicationId: applicationCredentials.applicationId,
    })
    .from(applicationCredentials)
    .innerJoin(
      applications,
      and(
        eq(applications.id, applicationCredentials.applicationId),
        eq(applications.tenantId, applicationCredentials.tenantId),
        eq(applications.status, 'active'),
      ),
    )
    .innerJoin(
      tenants,
      and(eq(tenants.id, applicationCredentials.tenantId), eq(tenants.status, 'active')),
    )
    .where(
      and(
        eq(applicationCredentials.keyId, keyId),
        isNull(applicationCredentials.revokedAt),
        or(isNull(applicationCredentials.expiresAt), gt(applicationCredentials.expiresAt, now)),
      ),
    )
    .limit(1);
  return credential ?? null;
}

export async function recordCredentialUse(id: string, now: Date): Promise<void> {
  await db
    .update(applicationCredentials)
    .set({ lastUsedAt: now })
    .where(and(eq(applicationCredentials.id, id), isNull(applicationCredentials.revokedAt)));
}
