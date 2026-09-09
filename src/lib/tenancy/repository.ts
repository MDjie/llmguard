import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { listEffectiveApplications } from '@/lib/iam/grants';
import { db } from '@/storage/database/shared/db';
import {
  applicationCredentials,
  applications,
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
  const rows = await listEffectiveApplications(userId, requestedTenantId);
  const selected = rows.find(row => requestedApplicationId ? row.app.id === requestedApplicationId : row.app.id === row.defaultId);
  return selected ? { tenantId: selected.app.tenantId, applicationId: selected.app.id } : null;
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
