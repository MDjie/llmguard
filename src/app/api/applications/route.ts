import { and, asc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { applications } from '@/storage/database/shared/schema';
import {
  applicationListResponseSchema,
  applicationResponseSchema,
  createApplicationSchema,
} from '@/contracts/http/tenancy';
import { emptyQuerySchema } from '@/contracts/http/common';

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
    permission: 'application:read',
    querySchema: emptyQuerySchema,
    responseSchema: applicationListResponseSchema,
    rateLimitPolicy: { id: 'applications-list', windowMs: 60_000, maxRequests: 60, scope: 'tenant' },
    maxBodyBytes: 0,
    auditEvent: 'application.list',
  },
  async ({ principal }) => {
    const scope = requireTenantContext(principal);
    const rows = await db
      .select()
      .from(applications)
      .where(eq(applications.tenantId, scope.tenantId))
      .orderBy(asc(applications.code));
    return NextResponse.json({ items: rows.map(applicationDto) });
  },
);

export const POST = withApiSecurity(
  {
    permission: 'application:manage',
    bodySchema: createApplicationSchema,
    responseSchema: applicationResponseSchema,
    rateLimitPolicy: { id: 'applications-create', windowMs: 60_000, maxRequests: 20, scope: 'tenant' },
    maxBodyBytes: 16_384,
    auditEvent: 'application.create',
  },
  async ({ body, principal }) => {
    const scope = requireTenantContext(principal);
    const [created] = await db.insert(applications).values({
      tenantId: scope.tenantId,
      code: body.code,
      name: body.name,
    }).returning();
    return NextResponse.json(applicationDto(created), { status: 201 });
  },
);

export const DELETE = withApiSecurity(
  {
    permission: 'application:manage',
    querySchema: z.object({ id: z.string().min(1).max(128) }).strict(),
    responseSchema: z.object({ success: z.literal(true) }),
    rateLimitPolicy: { id: 'applications-disable', windowMs: 60_000, maxRequests: 20, scope: 'tenant' },
    maxBodyBytes: 0,
    auditEvent: 'application.disable',
  },
  async ({ query, principal }) => {
    const scope = requireTenantContext(principal);
    await db.update(applications).set({ status: 'disabled', updatedAt: new Date() }).where(and(
      eq(applications.id, query.id),
      eq(applications.tenantId, scope.tenantId),
    ));
    return NextResponse.json({ success: true as const });
  },
);
