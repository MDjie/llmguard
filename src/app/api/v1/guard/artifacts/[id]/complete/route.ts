import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { artifactParamsSchema, completeArtifactUploadSchema } from '@/contracts/http/artifacts';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { ArtifactError, completeArtifactUpload } from '@/lib/artifacts';
import { requireTenantContext } from '@/lib/tenancy';

export const POST = withApiSecurity(
  {
    permission: 'guard:use',
    paramsSchema: artifactParamsSchema,
    bodySchema: completeArtifactUploadSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 2 * 1_024 * 1_024,
    auditEvent: 'artifact.upload.complete',
    rateLimitPolicy: { id: 'artifact-upload-complete', windowMs: 60_000, maxRequests: 30, scope: 'application' },
  },
  async ({ body, principal, routeContext }) => {
    const { id } = await (routeContext as { params: Promise<{ id: string }> }).params;
    try {
      const artifact = await completeArtifactUpload(
        requireTenantContext(principal), principal!.subject, id, body.parts,
      );
      return Response.json({ success: true, data: artifact }, { status: 202 });
    } catch (error) {
      if (error instanceof ArtifactError) {
        throw new ApiProblem({ status: 409, code: error.code, title: 'Upload completion rejected', detail: error.message });
      }
      throw error;
    }
  },
);
