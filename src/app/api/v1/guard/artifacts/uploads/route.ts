import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { createArtifactUploadSchema } from '@/contracts/http/artifacts';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { ArtifactError, createArtifactUpload } from '@/lib/artifacts';
import { requireTenantContext } from '@/lib/tenancy';

function artifactProblem(error: ArtifactError): ApiProblem {
  return new ApiProblem({
    status: error.code === 'GRD_ARTIFACT_TOO_LARGE' ? 413 :
      error.code === 'GRD_IDEMPOTENCY_CONFLICT' ? 409 : 400,
    code: error.code,
    title: 'Artifact request rejected',
    detail: error.message,
  });
}

export const POST = withApiSecurity(
  {
    permission: 'guard:use',
    bodySchema: createArtifactUploadSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 128 * 1_024,
    auditEvent: 'artifact.upload.create',
    rateLimitPolicy: { id: 'artifact-upload-create', windowMs: 60_000, maxRequests: 30, scope: 'application' },
  },
  async ({ body, principal }) => {
    try {
      const result = await createArtifactUpload({
        scope: requireTenantContext(principal),
        ownerId: principal!.subject,
        ...body,
      });
      return Response.json({
        success: true,
        data: result.artifact,
        reused: result.reused,
        links: {
          signPart: `/api/v1/guard/artifacts/${result.artifact.id}/parts/{partNumber}`,
          complete: `/api/v1/guard/artifacts/${result.artifact.id}/complete`,
        },
      }, { status: result.reused ? 200 : 201 });
    } catch (error) {
      if (error instanceof ArtifactError) throw artifactProblem(error);
      throw error;
    }
  },
);
