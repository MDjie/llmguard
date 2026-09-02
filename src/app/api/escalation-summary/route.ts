import { z } from 'zod';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { withApiSecurity } from '@/lib/api-security';
import { handlePolicyEscalationOnce } from '@/lib/policy/escalation-service';
import { requireTenantContext } from '@/lib/tenancy';

const bodySchema = z
  .object({
    userId: z.string().max(128).optional(),
    sessionId: z.string().min(1).max(128),
    policyId: z.string().min(1).max(36),
    inputHasRisk: z.boolean().default(false),
    outputHasRisk: z.boolean().default(false),
  })
  .strict();

export const POST = withApiSecurity(
  {
    permission: 'guard:use',
    bodySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 16 * 1_024,
    auditEvent: 'policy.escalation.evaluate',
    rateLimitPolicy: {
      id: 'policy-escalation-evaluate',
      windowMs: 60_000,
      maxRequests: 120,
      scope: 'principal',
    },
  },
  async ({ body, principal }) => {
    if (!principal) {
      throw new Error('Authenticated principal missing after authorization');
    }

    const result = await handlePolicyEscalationOnce(
      requireTenantContext(principal),
      principal.subject,
      body.sessionId,
      body.inputHasRisk || body.outputHasRisk,
      body.policyId,
    );

    return Response.json({
      success: true,
      data: result,
    });
  },
);
