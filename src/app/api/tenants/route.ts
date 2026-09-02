import { asc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { applications, tenantMemberships, tenants } from '@/storage/database/shared/schema';
import {
  createTenantSchema,
  createdTenantResponseSchema,
  tenantListResponseSchema,
} from '@/contracts/http/tenancy';
import { emptyQuerySchema } from '@/contracts/http/common';

function tenantDto(row: typeof tenants.$inferSelect) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status as 'active' | 'disabled',
    createdAt: row.createdAt.toISOString(),
  };
}

function applicationDto(row: typeof applications.$inferSelect) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    status: row.status as 'active' | 'disabled',
    createdAt: row.createdAt.toISOString(),
  };
}

export const GET = withApiSecurity(
  {
    permission: 'tenant:read',
    querySchema: emptyQuerySchema,
    responseSchema: tenantListResponseSchema,
    rateLimitPolicy: { id: 'tenants-list', windowMs: 60_000, maxRequests: 60, scope: 'principal' },
    maxBodyBytes: 0,
    auditEvent: 'tenant.list',
  },
  async ({ principal }) => {
    const scope = requireTenantContext(principal);
    const systemAdmin = principal?.roles.includes('SYSTEM_ADMIN');
    const rows = await db
      .select()
      .from(tenants)
      .where(systemAdmin ? undefined : eq(tenants.id, scope.tenantId))
      .orderBy(asc(tenants.code));
    return NextResponse.json({ items: rows.map(tenantDto) });
  },
);

export const POST = withApiSecurity(
  {
    permission: 'tenant:manage',
    bodySchema: createTenantSchema,
    responseSchema: createdTenantResponseSchema,
    rateLimitPolicy: { id: 'tenants-create', windowMs: 60_000, maxRequests: 10, scope: 'principal' },
    maxBodyBytes: 16_384,
    auditEvent: 'tenant.create',
  },
  async ({ body, principal }) => {
    const created = await db.transaction(async (transaction) => {
      const [tenant] = await transaction.insert(tenants).values({
        code: body.code,
        name: body.name,
      }).returning();
      const [application] = await transaction.insert(applications).values({
        tenantId: tenant.id,
        code: body.defaultApplicationCode,
        name: body.defaultApplicationName,
      }).returning();
      await transaction.insert(tenantMemberships).values({
        tenantId: tenant.id,
        userId: principal!.subject,
        defaultApplicationId: application.id,
      });
      return { tenant, application };
    });
    return NextResponse.json({
      tenant: tenantDto(created.tenant),
      application: applicationDto(created.application),
    }, { status: 201 });
  },
);
