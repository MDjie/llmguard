import { and, eq, inArray } from 'drizzle-orm';
import { emptyQuerySchema, jsonObjectResponseSchema } from '@/contracts/http/common';
import { artifactParamsSchema } from '@/contracts/http/artifacts';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { artifacts } from '@/storage/database/shared/schema';

async function ownedArtifact(scope: ReturnType<typeof requireTenantContext>, ownerId: string, id: string) {
  const [artifact] = await db.select().from(artifacts).where(and(
    eq(artifacts.id, id), eq(artifacts.ownerId, ownerId), scopePredicate(artifacts, scope),
  )).limit(1);
  if (!artifact) throw new ApiProblem({
    status: 404, code: 'GRD_ARTIFACT_NOT_FOUND', title: 'Artifact not found',
    detail: 'The artifact does not exist in the current principal and application scope.',
  });
  return artifact;
}

export const GET = withApiSecurity(
  {
    permission: 'guard:use', paramsSchema: artifactParamsSchema, querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema, maxBodyBytes: 0, auditEvent: 'artifact.read',
    rateLimitPolicy: { id: 'artifact-read', windowMs: 60_000, maxRequests: 120, scope: 'application' },
  },
  async ({ principal, routeContext }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    const artifact = await ownedArtifact(requireTenantContext(principal), principal!.subject, id);
    return Response.json({ success: true, data: artifact });
  },
);

export const DELETE = withApiSecurity(
  {
    permission: 'guard:use', paramsSchema: artifactParamsSchema, querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema, maxBodyBytes: 0, auditEvent: 'artifact.cancel',
    rateLimitPolicy: { id: 'artifact-cancel', windowMs: 60_000, maxRequests: 30, scope: 'application' },
  },
  async ({ principal, routeContext }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    const scope = requireTenantContext(principal);
    await ownedArtifact(scope, principal!.subject, id);
    const [artifact] = await db.update(artifacts).set({ state: 'deleted' }).where(and(
      eq(artifacts.id, id), eq(artifacts.ownerId, principal!.subject),
      inArray(artifacts.state, ['uploading', 'failed', 'quarantined']),
      scopePredicate(artifacts, scope),
    )).returning();
    if (!artifact) throw new ApiProblem({
      status: 409, code: 'GRD_ARTIFACT_NOT_CANCELLABLE', title: 'Artifact cancellation rejected',
      detail: 'Accepted or actively verifying artifacts cannot be cancelled by this endpoint.',
    });
    return Response.json({ success: true, data: artifact });
  },
);
