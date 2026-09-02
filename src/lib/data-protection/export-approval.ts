import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { exportHistoryQuerySchema } from '@/contracts/http/history';
import { ApiProblem } from '@/lib/api-security';
import { db } from '@/storage/database/shared/db';
import { exportApprovalRequests } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';

export type ExportQuery = z.infer<typeof exportHistoryQuerySchema>;

export function exportApprovalRequired(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (environment.EXPORT_APPROVAL_REQUIRED === 'true') return true;
  if (environment.EXPORT_APPROVAL_REQUIRED === 'false') return false;
  return environment.NODE_ENV === 'production';
}

export function exportQueryHash(query: ExportQuery): string {
  const canonical = JSON.stringify({
    action: query.action ?? null,
    endDate: query.endDate ?? null,
    format: query.format,
    riskType: query.riskType ?? null,
    startDate: query.startDate ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export async function consumeExportApproval(
  scope: TenantScope,
  approvalId: string | null,
  requesterId: string,
  query: ExportQuery,
): Promise<void> {
  if (!exportApprovalRequired()) return;
  if (!approvalId) {
    throw new ApiProblem({
      status: 428,
      code: 'EXPORT_APPROVAL_REQUIRED',
      title: 'Export approval required',
      detail: 'A valid export approval must be supplied in x-export-approval-id.',
    });
  }
  const [approval] = await db.select().from(exportApprovalRequests)
    .where(and(
      eq(exportApprovalRequests.id, approvalId),
      scopePredicate(exportApprovalRequests, scope),
    )).limit(1);
  if (
    !approval ||
    approval.requesterId !== requesterId ||
    approval.status !== 'approved' ||
    approval.expiresAt.getTime() <= Date.now() ||
    approval.queryHash !== exportQueryHash(query)
  ) {
    throw new ApiProblem({
      status: 403,
      code: 'EXPORT_APPROVAL_INVALID',
      title: 'Export denied',
      detail: 'The export approval is invalid, expired, consumed, or does not match this export.',
    });
  }
  const [consumed] = await db.update(exportApprovalRequests).set({
    status: 'consumed',
    consumedAt: new Date(),
  }).where(and(
    eq(exportApprovalRequests.id, approvalId),
    eq(exportApprovalRequests.status, 'approved'),
    scopePredicate(exportApprovalRequests, scope),
  )).returning({ id: exportApprovalRequests.id });
  if (!consumed) {
    throw new ApiProblem({
      status: 409,
      code: 'EXPORT_APPROVAL_ALREADY_USED',
      title: 'Export denied',
      detail: 'The export approval has already been consumed.',
    });
  }
}
