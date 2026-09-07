import { readAccessResourceDigest, type ContentResourceType } from '@/lib/content-access/resources';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { ApiProblem } from '@/lib/api-security';
import { maskPII } from '@/lib/guardrail/pii-masker';
import { observeHumanReview } from '@/lib/observability/metrics';
import { redactText } from '@/lib/observability/logger';
import { scopePredicate, type TenantContext } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { contentAccessRequests, securityIncidents } from '@/storage/database/shared/schema';
import { incidentEvidenceDigest } from './projection';

export type ContentAccessPurpose =
  | 'INCIDENT_INVESTIGATION'
  | 'REGULATORY_REVIEW'
  | 'FALSE_POSITIVE_APPEAL';

function problem(status: 404 | 409 | 422, code: string, detail: string): ApiProblem {
  return new ApiProblem({ status, code, title: 'Content access request rejected', detail });
}

function safeReason(value: string): string {
  const normalized = value.trim().replace(/[\u0000-\u001F\u007F]/gu, ' ');
  return maskPII(redactText(normalized)).maskedText.slice(0, 500);
}

export function resolveContentAccessStatus(
  input: { readonly status: string; readonly expiresAt: Date | null; readonly usedAt: Date | null },
  now = new Date(),
): string {
  if (input.status === 'approved' && input.usedAt === null && input.expiresAt !== null
    && input.expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  return input.status;
}

function publicRequest(row: typeof contentAccessRequests.$inferSelect, now = new Date()) {
  return {
    id: row.id,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    sourceDigest: row.sourceDigest,
    requesterId: row.requesterId,
    purpose: row.purpose,
    reason: row.reason,
    status: resolveContentAccessStatus(row, now),
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    decisionReason: row.decisionReason,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    createdAt: row.createdAt,
  };
}

export async function requestEvidenceAccess(
  scope: TenantContext,
  incidentId: string,
  input: { readonly purpose: ContentAccessPurpose; readonly reason: string },
  resourceType: ContentResourceType = 'INCIDENT_EVIDENCE',
) {
  const result = await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${scope.tenantId + ':' + scope.applicationId + ':' + incidentId + ':' + scope.principalId}))`);
    const sourceDigest = await readAccessResourceDigest(transaction, scope, resourceType, incidentId);
    if (!sourceDigest) throw problem(404, 'CONTENT_RESOURCE_NOT_FOUND', 'The resource is unavailable in this application.');
    const [existing] = await transaction.select().from(contentAccessRequests).where(and(
      scopePredicate(contentAccessRequests, scope),
      eq(contentAccessRequests.resourceType, resourceType),
      eq(contentAccessRequests.resourceId, incidentId),
      eq(contentAccessRequests.requesterId, scope.principalId),
      eq(contentAccessRequests.status, 'pending'),
    )).limit(1);
    if (existing) {
      if (existing.purpose !== input.purpose) throw problem(409, 'CONTENT_ACCESS_PURPOSE_CONFLICT', 'A pending request already exists for another purpose; resolve it before requesting a different use.');
      if (existing.sourceDigest !== sourceDigest) {
        throw problem(409, 'CONTENT_ACCESS_SOURCE_CHANGED', 'The evidence changed after the pending request was created.');
      }
      return existing;
    }
    const [created] = await transaction.insert(contentAccessRequests).values({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      resourceType,
      resourceId: incidentId,
      sourceDigest,
      requesterId: scope.principalId,
      purpose: input.purpose,
      reason: safeReason(input.reason),
      status: 'pending',
    }).returning();
    if (!created) throw new Error('Content access request insert returned no row');
    return created;
  });
  observeHumanReview({ workflow: 'content_access', agreement: 'pending' });
  return publicRequest(result);
}

export async function listContentAccessRequests(
  scope: TenantContext,
  input: { readonly status: string; readonly limit: number; readonly offset: number },
) {
  const now = new Date();
  const statusPredicate = input.status === 'expired'
    ? sql<boolean>`(${contentAccessRequests.status} = 'expired' OR (${contentAccessRequests.status} = 'approved' AND ${contentAccessRequests.usedAt} IS NULL AND ${contentAccessRequests.expiresAt} <= ${now}))`
    : input.status === 'approved'
      ? sql<boolean>`(${contentAccessRequests.status} = 'approved' AND NOT (${contentAccessRequests.usedAt} IS NULL AND ${contentAccessRequests.expiresAt} <= ${now}))`
      : eq(contentAccessRequests.status, input.status);
  const predicate = and(scopePredicate(contentAccessRequests, scope), statusPredicate);
  const [rows, counts] = await Promise.all([
    db.select().from(contentAccessRequests).where(predicate)
      .orderBy(desc(contentAccessRequests.createdAt)).limit(input.limit).offset(input.offset),
    db.select({ count: sql<number>`count(*)::integer` }).from(contentAccessRequests).where(predicate),
  ]);
  return { items: rows.map((row) => publicRequest(row, now)), total: Number(counts[0]?.count ?? 0) };
}

export async function listRequesterEvidenceAccess(
  scope: TenantContext,
  incidentId: string,
  resourceType: ContentResourceType = 'INCIDENT_EVIDENCE',
) {
  const rows = await db.select().from(contentAccessRequests).where(and(
    scopePredicate(contentAccessRequests, scope),
    eq(contentAccessRequests.resourceType, resourceType),
    eq(contentAccessRequests.resourceId, incidentId),
    eq(contentAccessRequests.requesterId, scope.principalId),
  )).orderBy(desc(contentAccessRequests.createdAt)).limit(20);
  return rows.map((row) => publicRequest(row));
}

export async function reviewContentAccessRequest(
  scope: TenantContext,
  requestId: string,
  input: { readonly action: 'approve' | 'reject'; readonly reason: string },
) {
  const result = await db.transaction(async (transaction) => {
    const [current] = await transaction.select().from(contentAccessRequests).where(and(
      scopePredicate(contentAccessRequests, scope),
      eq(contentAccessRequests.id, requestId),
    )).limit(1).for('update');
    if (!current) throw problem(404, 'CONTENT_ACCESS_REQUEST_NOT_FOUND', 'The access request does not exist in this application scope.');
    if (current.status !== 'pending') throw problem(409, 'CONTENT_ACCESS_STATE_INVALID', 'Only a pending access request can be reviewed.');
    if (current.requesterId === scope.principalId) {
      throw problem(409, 'CONTENT_ACCESS_INDEPENDENT_APPROVAL_REQUIRED', 'The requester cannot review their own access request.');
    }
    const digest = await readAccessResourceDigest(transaction, scope, current.resourceType, current.resourceId, new Date(), true);
    if (!digest || digest !== current.sourceDigest) throw problem(409, 'CONTENT_ACCESS_SOURCE_CHANGED', 'The evidence no longer matches the reviewed digest.');
    const now = new Date();
    const status = input.action === 'approve' ? 'approved' : 'rejected';
    const [updated] = await transaction.update(contentAccessRequests).set({
      status,
      reviewedBy: scope.principalId,
      reviewedAt: now,
      decisionReason: safeReason(input.reason),
      expiresAt: input.action === 'approve' ? new Date(now.getTime() + 15 * 60_000) : null,
    }).where(and(
      scopePredicate(contentAccessRequests, scope),
      eq(contentAccessRequests.id, requestId),
      eq(contentAccessRequests.status, 'pending'),
    )).returning();
    if (!updated) throw problem(409, 'CONTENT_ACCESS_STATE_CONFLICT', 'The access request changed during review.');
    return updated;
  });
  observeHumanReview({
    workflow: 'content_access',
    agreement: input.action === 'approve' ? 'agree' : 'disagree',
    cycleMs: Math.max(0, (result.reviewedAt?.getTime() ?? Date.now()) - result.createdAt.getTime()),
  });
  return publicRequest(result);
}

export async function consumeIncidentEvidenceAccess(
  scope: TenantContext,
  incidentId: string,
  requestId: string,
) {
  return db.transaction(async (transaction) => {
    const now = new Date();
    const [access] = await transaction.select().from(contentAccessRequests).where(and(
      scopePredicate(contentAccessRequests, scope),
      eq(contentAccessRequests.id, requestId),
      eq(contentAccessRequests.resourceType, 'INCIDENT_EVIDENCE'),
      eq(contentAccessRequests.resourceId, incidentId),
      eq(contentAccessRequests.requesterId, scope.principalId),
      eq(contentAccessRequests.status, 'approved'),
      gt(contentAccessRequests.expiresAt, now),
    )).limit(1).for('update');
    if (!access) throw problem(404, 'CONTENT_ACCESS_GRANT_NOT_FOUND', 'No active approved grant exists for this evidence and requester.');
    if (access.usedAt) throw problem(409, 'CONTENT_ACCESS_GRANT_CONSUMED', 'This one-time access grant has already been used.');
    const [incident] = await transaction.select({ answerEvidence: securityIncidents.answerEvidence })
      .from(securityIncidents).where(and(
        scopePredicate(securityIncidents, scope),
        eq(securityIncidents.id, incidentId),
      )).limit(1).for('update');
    if (!incident || incidentEvidenceDigest(incident.answerEvidence) !== access.sourceDigest) {
      throw problem(409, 'CONTENT_ACCESS_SOURCE_CHANGED', 'The evidence changed after approval; request access again.');
    }
    const [consumed] = await transaction.update(contentAccessRequests).set({ usedAt: now }).where(and(
      scopePredicate(contentAccessRequests, scope),
      eq(contentAccessRequests.id, access.id),
      eq(contentAccessRequests.status, 'approved'),
    )).returning({ usedAt: contentAccessRequests.usedAt });
    if (!consumed?.usedAt) throw problem(409, 'CONTENT_ACCESS_STATE_CONFLICT', 'The access grant changed during retrieval.');
    return {
      incidentId,
      accessRequestId: access.id,
      sourceDigest: access.sourceDigest,
      expiresAt: access.expiresAt,
      consumedAt: consumed.usedAt,
      answerEvidence: incident.answerEvidence,
    };
  });
}

export const requestIncidentEvidenceAccess = requestEvidenceAccess;
export const listRequesterIncidentEvidenceAccess = listRequesterEvidenceAccess;
