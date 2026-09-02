import { and, desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import {
  decideExportApprovalSchema,
  exportApprovalListQuerySchema,
  requestExportApprovalSchema,
} from '@/contracts/http/history';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { withApiSecurity, ApiProblem } from '@/lib/api-security';
import { exportQueryHash } from '@/lib/data-protection/export-approval';
import { db, exportApprovalRequests } from '@/lib/db';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000;
const APPROVAL_RATE_LIMIT = {
  id: 'export-approval', windowMs: 60_000, maxRequests: 30, scope: 'principal' as const,
};

export const POST = withApiSecurity(
  {
    permission: 'audit:export',
    bodySchema: requestExportApprovalSchema,
    responseSchema: jsonObjectResponseSchema,
    rateLimitPolicy: APPROVAL_RATE_LIMIT,
    maxBodyBytes: 16_384,
    auditEvent: 'export.approval.request',
  },
  async ({ body, principal }) => {
    const scope = requireTenantContext(principal);
    const [request] = await db.insert(exportApprovalRequests).values({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      requesterId: principal!.subject,
      purpose: body.purpose,
      queryHash: exportQueryHash(body.exportQuery),
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    }).returning({ id: exportApprovalRequests.id, status: exportApprovalRequests.status, expiresAt: exportApprovalRequests.expiresAt });
    return NextResponse.json({ success: true, data: request }, { status: 201 });
  },
);

export const PATCH = withApiSecurity(
  {
    permission: 'audit:approve',
    bodySchema: decideExportApprovalSchema,
    responseSchema: jsonObjectResponseSchema,
    rateLimitPolicy: APPROVAL_RATE_LIMIT,
    maxBodyBytes: 4_096,
    auditEvent: 'export.approval.decide',
  },
  async ({ body, principal }) => {
    const scope = requireTenantContext(principal);
    const [request] = await db.select().from(exportApprovalRequests)
      .where(and(
        eq(exportApprovalRequests.id, body.id),
        scopePredicate(exportApprovalRequests, scope),
      )).limit(1);
    if (!request || request.status !== 'pending' || request.expiresAt.getTime() <= Date.now()) {
      throw new ApiProblem({ status: 409, code: 'EXPORT_APPROVAL_NOT_PENDING', title: 'Approval unavailable', detail: 'The approval request is missing, expired, or no longer pending.' });
    }
    if (request.requesterId === principal!.subject) {
      throw new ApiProblem({ status: 403, code: 'EXPORT_SELF_APPROVAL_DENIED', title: 'Approval denied', detail: 'The requester cannot approve their own export.' });
    }
    const [updated] = await db.update(exportApprovalRequests).set({
      status: body.decision,
      approverId: principal!.subject,
      decidedAt: new Date(),
    }).where(and(
      eq(exportApprovalRequests.id, body.id),
      eq(exportApprovalRequests.status, 'pending'),
      scopePredicate(exportApprovalRequests, scope),
    )).returning({ id: exportApprovalRequests.id, status: exportApprovalRequests.status });
    if (!updated) throw new ApiProblem({ status: 409, code: 'EXPORT_APPROVAL_RACE', title: 'Approval unavailable', detail: 'The approval request was already decided.' });
    return NextResponse.json({ success: true, data: updated });
  },
);

export const GET = withApiSecurity(
  {
    permission: 'audit:approve',
    querySchema: exportApprovalListQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    rateLimitPolicy: APPROVAL_RATE_LIMIT,
    maxBodyBytes: 0,
    auditEvent: 'export.approval.list',
  },
  async ({ query, principal }) => {
    const scope = requireTenantContext(principal);
    const items = await db.select({
      id: exportApprovalRequests.id,
      requesterId: exportApprovalRequests.requesterId,
      approverId: exportApprovalRequests.approverId,
      status: exportApprovalRequests.status,
      purpose: exportApprovalRequests.purpose,
      expiresAt: exportApprovalRequests.expiresAt,
      decidedAt: exportApprovalRequests.decidedAt,
      createdAt: exportApprovalRequests.createdAt,
    }).from(exportApprovalRequests).where(and(
      eq(exportApprovalRequests.status, query.status),
      scopePredicate(exportApprovalRequests, scope),
    ))
      .orderBy(desc(exportApprovalRequests.createdAt)).limit(query.limit);
    return NextResponse.json({ success: true, data: items });
  },
);
