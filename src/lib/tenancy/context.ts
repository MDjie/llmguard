import { and, eq, type AnyColumn, type SQL } from 'drizzle-orm';
import { ApiProblem } from '@/lib/api-security/problem';
import type { AuthenticatedPrincipal } from '@/lib/api-security/types';

export const TENANT_HEADER_NAME = 'x-guard-tenant-id';
export const APPLICATION_HEADER_NAME = 'x-guard-application-id';

export interface TenantScope {
  readonly tenantId: string;
  readonly applicationId: string;
}

export interface TenantContext extends TenantScope {
  readonly principalId: string;
}

export const LEGACY_TENANT_SCOPE: TenantScope = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  applicationId: '00000000-0000-0000-0000-000000000002',
};

export function requireTenantContext(
  principal: AuthenticatedPrincipal | null,
): TenantContext {
  if (!principal?.tenantId || !principal.applicationId) {
    throw new ApiProblem({
      status: 403,
      code: 'TENANT_CONTEXT_REQUIRED',
      title: 'Tenant context required',
      detail: 'The authenticated identity is not bound to an active tenant and application.',
    });
  }
  return {
    tenantId: principal.tenantId,
    applicationId: principal.applicationId,
    principalId: principal.subject,
  };
}

export function scopePredicate(
  columns: { readonly tenantId: AnyColumn; readonly applicationId: AnyColumn },
  scope: TenantScope,
): SQL {
  return and(
    eq(columns.tenantId, scope.tenantId),
    eq(columns.applicationId, scope.applicationId),
  ) as SQL;
}

export function scopedInsert<T extends Record<string, unknown>>(
  scope: TenantScope,
  value: T,
): T & TenantScope {
  return {
    ...value,
    tenantId: scope.tenantId,
    applicationId: scope.applicationId,
  };
}

export function assertRowScope(
  scope: TenantScope,
  row: TenantScope | null | undefined,
): void {
  if (!row || row.tenantId !== scope.tenantId || row.applicationId !== scope.applicationId) {
    throw new ApiProblem({
      status: 404,
      code: 'SCOPED_RESOURCE_NOT_FOUND',
      title: 'Resource not found',
      detail: 'The requested resource does not exist in the authenticated scope.',
    });
  }
}
