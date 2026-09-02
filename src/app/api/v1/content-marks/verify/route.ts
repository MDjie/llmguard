import { verifyContentMarkRequestSchema, verifyContentMarkResponseSchema } from '@/contracts/http/content-marks';
import { withApiSecurity } from '@/lib/api-security';
import { resolveContentMarkingConfiguration, verifyContentMark } from '@/lib/content-marking';

export const POST = withApiSecurity(
  {
    permission: 'audit:read',
    bodySchema: verifyContentMarkRequestSchema,
    responseSchema: verifyContentMarkResponseSchema,
    maxBodyBytes: 16_384,
    auditEvent: 'content.mark.verify',
    rateLimitPolicy: { id: 'content-mark-verify', windowMs: 60_000, maxRequests: 120, scope: 'principal' },
  },
  async ({ body }) => {
    const configuration = resolveContentMarkingConfiguration();
    const valid = body.keyId === configuration.keyId && verifyContentMark(body, configuration.key);
    return Response.json({ valid, contentId: body.metadata.contentId, standard: body.metadata.standard });
  },
);
