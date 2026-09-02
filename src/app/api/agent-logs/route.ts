import { and, desc, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { withApiSecurity } from '@/lib/api-security';
import { db, agentTraces } from '@/lib/db';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  workflowType: z.string().max(64).optional(),
  sessionId: z.string().max(128).optional(),
}).strict();

export const GET = withApiSecurity(
  {
    permission: 'audit:read',
    querySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'agent-log.list',
    rateLimitPolicy: { id: 'agent-log-list', windowMs: 60_000, maxRequests: 60, scope: 'principal' },
  },
  async ({ query, principal }) => {
    const scope = requireTenantContext(principal);
    const conditions = [scopePredicate(agentTraces, scope)];
    if (query.workflowType) conditions.push(eq(agentTraces.workflowName, query.workflowType));
    if (query.sessionId) conditions.push(eq(agentTraces.recordId, query.sessionId));
    const where = and(...conditions);
    const offset = (query.page - 1) * query.pageSize;
    const [items, countRows] = await Promise.all([
      db.select({
        id: agentTraces.id,
        recordId: agentTraces.recordId,
        providerId: agentTraces.providerId,
        workflowName: agentTraces.workflowName,
        latencyMs: agentTraces.latencyMs,
        success: agentTraces.success,
        createdAt: agentTraces.createdAt,
      }).from(agentTraces).where(where).orderBy(desc(agentTraces.createdAt))
        .limit(query.pageSize).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(agentTraces).where(where),
    ]);
    const total = Number(countRows[0]?.count ?? 0);
    return NextResponse.json({
      success: true,
      data: {
        items,
        total,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.ceil(total / query.pageSize),
      },
    });
  },
);
