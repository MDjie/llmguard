import { createHash } from 'node:crypto';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { guardRagFlowSchema } from '@/contracts/http/rag';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { loadRuntimePolicyBundle } from '@/lib/policy-bundle';
import { guardRagFlow } from '@/lib/rag';
import { requireTenantContext } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { ragRetrievalAudits } from '@/storage/database/shared/schema';

function clearance(roles: readonly string[]): number {
  if (roles.includes('SYSTEM_ADMIN') || roles.includes('SECURITY_ADMIN')) return 10;
  if (roles.includes('AUDIT_ADMIN')) return 8;
  if (roles.includes('BUSINESS_OPERATOR') || roles.includes('APP_DEVELOPER')) return 5;
  return 3;
}

export const POST = withApiSecurity(
  {
    permission: 'guard:use',
    bodySchema: guardRagFlowSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 8 * 1_024 * 1_024,
    auditEvent: 'guard.rag.evaluate',
    rateLimitPolicy: { id: 'guard-rag-evaluate', windowMs: 60_000, maxRequests: 120, scope: 'application' },
  },
  async ({ body, principal }) => {
    const scope = requireTenantContext(principal);
    if (body.absoluteDeadlineEpochMs <= Date.now() || body.absoluteDeadlineEpochMs - Date.now() > 60_000) {
      throw new ApiProblem({
        status: 400, code: 'GRD_RAG_DEADLINE_INVALID', title: 'Invalid RAG deadline',
        detail: 'The RAG deadline must be within the next 60 seconds.',
      });
    }
    let bundle;
    try {
      bundle = await loadRuntimePolicyBundle(scope, body.bundleId, body.requestId);
    } catch {
      throw new ApiProblem({
        status: 503, code: 'GRD_RAG_POLICY_UNAVAILABLE', title: 'RAG policy unavailable',
        detail: 'The active signed policy bundle could not be loaded.',
      });
    }
    const result = await guardRagFlow({
      scope,
      principal: { id: principal!.subject, roles: principal!.roles, clearance: clearance(principal!.roles) },
      bundle,
      traceId: body.traceId,
      absoluteDeadlineEpochMs: body.absoluteDeadlineEpochMs,
      query: body.query,
      candidates: body.candidates,
      output: body.output,
      citedChunkIds: body.citedChunkIds,
      minimumTrustLevel: body.minimumTrustLevel,
      maximumCandidatesPerSource: body.maximumCandidatesPerSource,
    });
    await db.insert(ragRetrievalAudits).values({
      ...scope, principalId: principal!.subject, traceId: body.traceId,
      queryHash: createHash('sha256').update(body.query).digest('hex'),
      candidateCount: body.candidates.length,
      acceptedCount: result.acceptedChunkIds.length,
      rejected: result.rejected,
      tainted: result.tainted,
    });
    return Response.json({ success: true, data: result });
  },
);
