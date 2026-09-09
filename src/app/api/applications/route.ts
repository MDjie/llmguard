import { and, eq, sql } from 'drizzle-orm';
import { listEffectiveApplications, denied } from '@/lib/iam/grants';
import { userApplicationMemberships } from '@/lib/iam/schema';
import { grantAllowsApplication } from '@/lib/iam/policy';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { requireTenantContext } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { applications } from '@/storage/database/shared/schema';
import {
  applicationListResponseSchema,
  applicationResponseSchema,
  createApplicationSchema,
  updateApplicationSchema,
} from '@/contracts/http/tenancy';
import { emptyQuerySchema } from '@/contracts/http/common';

function applicationDto(row: typeof applications.$inferSelect) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    owner:row.owner,department:row.department,environment:row.environment,dataClass:row.dataClass,modelRoutes:row.modelRoutes,authVersion:row.authVersion,integrationState:row.integrationState,
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
    const rows = await listEffectiveApplications(principal!.subject, scope.tenantId);
    return NextResponse.json({ items: rows.map(row=>({...applicationDto(row.app),authorizationAttributes:row.grant.attributes})), currentApplicationId:scope.applicationId });
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
    const currentGrant = (await listEffectiveApplications(principal!.subject,scope.tenantId)).find(row=>row.app.id===scope.applicationId)?.grant;
    if (!currentGrant || !grantAllowsApplication(currentGrant.attributes,{environment:body.environment ?? 'development',dataClass:body.dataClass ?? 'internal',department:body.department})) throw denied('APPLICATION_ATTRIBUTES_DENIED');
    const created = await db.transaction(async tx => {
      const [row] = await tx.insert(applications).values({tenantId:scope.tenantId,...body}).returning();
      await tx.insert(userApplicationMemberships).values({userId:principal!.subject,tenantId:scope.tenantId,
        applicationId:row.id,attributes:currentGrant.attributes,expiresAt:currentGrant.expiresAt,grantedBy:principal!.subject});
      return row;
    });
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
    if (!(await listEffectiveApplications(principal!.subject,scope.tenantId)).some(row=>row.app.id===query.id)) throw denied('APPLICATION_GRANT_DENIED');
    await db.update(applications).set({ status: 'disabled', updatedAt: new Date() }).where(and(
      eq(applications.id, query.id),
      eq(applications.tenantId, scope.tenantId),
    ));
    return NextResponse.json({ success: true as const });
  },
);

export const PATCH = withApiSecurity({permission:'application:manage',bodySchema:updateApplicationSchema,responseSchema:applicationResponseSchema,maxBodyBytes:16384,auditEvent:'application.update',rateLimitPolicy:{id:'application-update',windowMs:60000,maxRequests:30,scope:'tenant'}},async({body,principal})=>{
  const scope=requireTenantContext(principal);
  const {id,expectedAuthVersion,...metadata}=body;
  const target=(await listEffectiveApplications(principal!.subject,scope.tenantId)).find(row=>row.app.id===id);
  if(!target || !grantAllowsApplication(target.grant.attributes,{environment:metadata.environment??target.app.environment,dataClass:metadata.dataClass??target.app.dataClass,department:metadata.department===undefined?target.app.department:metadata.department})) throw denied('APPLICATION_ATTRIBUTES_DENIED');
  const [updated]=await db.update(applications).set({...metadata,authVersion:sql`${applications.authVersion} + 1`,integrationState:'CONFIGURED',updatedAt:new Date()}).where(and(eq(applications.tenantId,scope.tenantId),eq(applications.id,id),eq(applications.authVersion,expectedAuthVersion))).returning();
  if(!updated)throw new ApiProblem({status:409,code:'APPLICATION_VERSION_CONFLICT',title:'应用配置已变化',detail:'请刷新后再保存。'});
  return NextResponse.json(applicationDto(updated));
});
