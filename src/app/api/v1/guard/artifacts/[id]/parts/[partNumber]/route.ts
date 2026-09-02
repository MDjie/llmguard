import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { artifactPartParamsSchema } from '@/contracts/http/artifacts';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { ArtifactError, signArtifactPart } from '@/lib/artifacts';
import { requireTenantContext } from '@/lib/tenancy';

export const POST = withApiSecurity(
  {
    permission: 'guard:use',
    paramsSchema: artifactPartParamsSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'artifact.part.sign',
    rateLimitPolicy: { id: 'artifact-part-sign', windowMs: 60_000, maxRequests: 600, scope: 'application' },
  },
  async ({ principal, routeContext }) => {
    const { id, partNumber } = await (routeContext as {
      params: Promise<{ id: string; partNumber: string }>;
    }).params;
    try {
      const signed = await signArtifactPart(
        requireTenantContext(principal), principal!.subject, id, Number(partNumber),
      );
      return Response.json({ success: true, data: signed });
    } catch (error) {
      if (error instanceof ArtifactError) {
        throw new ApiProblem({ status: 409, code: error.code, title: 'Part signing rejected', detail: error.message });
      }
      throw error;
    }
  },
);
