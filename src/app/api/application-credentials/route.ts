import { and, desc, eq, isNull } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import {
  createApplicationApiKey,
  requireTenantContext,
} from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import {
  applicationCredentials,
  applications,
} from '@/storage/database/shared/schema';
import {
  createApplicationCredentialSchema,
  createdApplicationCredentialResponseSchema,
  credentialListResponseSchema,
  revokeApplicationCredentialQuerySchema,
} from '@/contracts/http/tenancy';
import { emptyQuerySchema } from '@/contracts/http/common';

function credentialDto(row: typeof applicationCredentials.$inferSelect) {
  return {
    id: row.id,
    keyId: row.keyId,
    name: row.name,
    permissions: row.permissions as ('guard:use' | 'application:integrate')[],
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export const GET = withApiSecurity(
  {
    permission: 'application:credential:manage',
    querySchema: emptyQuerySchema,
    responseSchema: credentialListResponseSchema,
    rateLimitPolicy: { id: 'application-credentials-list', windowMs: 60_000, maxRequests: 60, scope: 'application' },
    maxBodyBytes: 0,
    auditEvent: 'application.credential.list',
  },
  async ({ principal }) => {
    const scope = requireTenantContext(principal);
    const rows = await db.select().from(applicationCredentials).where(and(
      eq(applicationCredentials.tenantId, scope.tenantId),
      eq(applicationCredentials.applicationId, scope.applicationId),
      isNull(applicationCredentials.revokedAt),
      principal!.roles.includes('APP_DEVELOPER') ? eq(applicationCredentials.createdBy,principal!.subject) : undefined,
    )).orderBy(desc(applicationCredentials.createdAt));
    return NextResponse.json({ items: rows.map(credentialDto) });
  },
);

export const POST = withApiSecurity(
  {
    permission: 'application:credential:manage',
    bodySchema: createApplicationCredentialSchema,
    responseSchema: createdApplicationCredentialResponseSchema,
    rateLimitPolicy: { id: 'application-credentials-create', windowMs: 60_000, maxRequests: 10, scope: 'application' },
    maxBodyBytes: 16_384,
    auditEvent: 'application.credential.create',
  },
  async ({ body, principal }) => {
    const scope = requireTenantContext(principal);
    const [application] = await db.select({ id: applications.id }).from(applications).where(and(
      eq(applications.id, scope.applicationId),
      eq(applications.tenantId, scope.tenantId),
      eq(applications.status, 'active'),
    )).limit(1);
    if (!application) {
      throw new ApiProblem({
        status: 409,
        code: 'APPLICATION_INACTIVE',
        title: 'Application is inactive',
        detail: 'Credentials can only be created for an active application.',
      });
    }
    const generated = createApplicationApiKey();
    const [created] = await db.insert(applicationCredentials).values({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      keyId: generated.keyId,
      name: body.name,
      secretHash: generated.secretHash,
      permissions: body.permissions,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      createdBy: principal!.subject,
    }).returning();
    return NextResponse.json({
      credential: credentialDto(created),
      apiKey: generated.apiKey,
    }, { status: 201 });
  },
);

export const DELETE = withApiSecurity(
  {
    permission: 'application:credential:manage',
    querySchema: revokeApplicationCredentialQuerySchema,
    responseSchema: z.object({ success: z.literal(true) }),
    rateLimitPolicy: { id: 'application-credentials-revoke', windowMs: 60_000, maxRequests: 20, scope: 'application' },
    maxBodyBytes: 0,
    auditEvent: 'application.credential.revoke',
  },
  async ({ query, principal }) => {
    const scope = requireTenantContext(principal);
    await db.update(applicationCredentials).set({ revokedAt: new Date() }).where(and(
      eq(applicationCredentials.id, query.id),
      principal!.roles.includes('APP_DEVELOPER') ? eq(applicationCredentials.createdBy,principal!.subject) : undefined,
      eq(applicationCredentials.tenantId, scope.tenantId),
      eq(applicationCredentials.applicationId, scope.applicationId),
      isNull(applicationCredentials.revokedAt),
    ));
    return NextResponse.json({ success: true as const });
  },
);
