import { z } from 'zod';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import {
  getUserPolicyState,
  resetSessionPolicyState,
} from '@/lib/policy/escalation-service';
import { requireTenantContext } from '@/lib/tenancy';

const querySchema = z
  .object({
    userId: z.string().max(128).optional(),
    sessionId: z.string().min(1).max(128),
    defaultPolicyId: z.string().min(1).max(36).optional(),
  })
  .strict();

const resetSchema = z
  .object({
    userId: z.string().max(128).optional(),
    sessionId: z.string().min(1).max(128),
    action: z.literal('reset'),
  })
  .strict();

export const GET = withApiSecurity(
  {
    permission: 'guard:use',
    querySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'policy.state.read',
    rateLimitPolicy: {
      id: 'policy-state-read',
      windowMs: 60_000,
      maxRequests: 120,
      scope: 'principal',
    },
  },
  async ({ query, principal }) => {
    if (!principal) {
      throw new Error('Authenticated principal missing after authorization');
    }

    const scope = requireTenantContext(principal);
    const state = await getUserPolicyState(scope, principal.subject, query.sessionId);
    const effectivePolicyId = state?.currentPolicyId ?? query.defaultPolicyId ?? '';

    return Response.json({
      success: true,
      data: {
        state,
        effectivePolicyId,
        hasState: Boolean(state),
      },
    });
  },
);

export const POST = withApiSecurity(
  {
    permission: 'guard:use',
    bodySchema: resetSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 16 * 1_024,
    auditEvent: 'policy.state.reset',
    rateLimitPolicy: {
      id: 'policy-state-reset',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  async ({ body, principal }) => {
    if (!principal) {
      throw new Error('Authenticated principal missing after authorization');
    }

    const result = await resetSessionPolicyState(
      requireTenantContext(principal),
      principal.subject,
      body.sessionId,
    );
    if (!result.success) {
      throw new ApiProblem({
        status: 409,
        code: 'POLICY_STATE_RESET_FAILED',
        title: 'Policy state was not reset',
        detail: 'The policy state could not be reset in its current state.',
      });
    }

    return Response.json({
      success: true,
      message: '策略状态已重置',
    });
  },
);
