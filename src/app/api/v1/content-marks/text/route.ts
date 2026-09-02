import { markTextRequestSchema, markTextResponseSchema } from '@/contracts/http/content-marks';
import { withApiSecurity } from '@/lib/api-security';
import { markGeneratedText } from '@/lib/content-marking';
import { requireTenantContext } from '@/lib/tenancy';

export const POST = withApiSecurity(
  {
    permission: 'guard:use',
    bodySchema: markTextRequestSchema,
    responseSchema: markTextResponseSchema,
    maxBodyBytes: 1_100_000,
    auditEvent: 'content.mark.text',
    rateLimitPolicy: { id: 'content-mark-text', windowMs: 60_000, maxRequests: 120, scope: 'application' },
  },
  async ({ body, principal }) => Response.json(await markGeneratedText(requireTenantContext(principal), body)),
);
