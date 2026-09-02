import { and, eq } from 'drizzle-orm';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { artifactParamsSchema } from '@/contracts/http/artifacts';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { artifacts } from '@/storage/database/shared/schema';

export const POST = withApiSecurity(
  {
    permission: 'guard:use', paramsSchema: artifactParamsSchema,
    responseSchema: jsonObjectResponseSchema, maxBodyBytes: 0, auditEvent: 'artifact.verify.retry',
    rateLimitPolicy: { id: 'artifact-retry', windowMs: 60_000, maxRequests: 10, scope: 'application' },
  },
  async ({ principal, routeContext }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    const scope = requireTenantContext(principal);
    const [artifact] = await db.update(artifacts).set({
      state: 'verifying', failureCode: null,
    }).where(and(
      eq(artifacts.id, id), eq(artifacts.ownerId, principal!.subject),
      eq(artifacts.state, 'failed'), scopePredicate(artifacts, scope),
    )).returning();
    if (!artifact) throw new ApiProblem({
      status: 409, code: 'GRD_ARTIFACT_RETRY_REJECTED', title: 'Artifact retry rejected',
      detail: 'Only transiently failed owned artifacts can be retried; integrity quarantine requires a new upload.',
    });
    return Response.json({ success: true, data: artifact }, { status: 202 });
  },
);
