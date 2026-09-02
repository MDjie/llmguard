import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { updateGatewayRoutingSchema } from '@/contracts/http/gateway-routing';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import {
  GatewayRoutingTransitionError,
  updateGatewayRouting,
} from '@/lib/gateway-routing';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { applicationRoutingConfigs } from '@/storage/database/shared/schema';

export const GET = withApiSecurity(
  {
    permission: 'application:read',
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'gateway-routing.read',
    rateLimitPolicy: { id: 'gateway-routing-read', windowMs: 60_000, maxRequests: 60, scope: 'application' },
  },
  async ({ principal }) => {
    const scope = requireTenantContext(principal);
    const [row] = await db.select().from(applicationRoutingConfigs)
      .where(scopePredicate(applicationRoutingConfigs, scope)).limit(1);
    return Response.json({
      success: true,
      data: row ?? { ...scope, mode: 'legacy', guardPercent: 0, generation: 0 },
    });
  },
);

export const PATCH = withApiSecurity(
  {
    permission: 'application:manage',
    bodySchema: updateGatewayRoutingSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 16 * 1_024,
    auditEvent: 'gateway-routing.transition',
    rateLimitPolicy: { id: 'gateway-routing-transition', windowMs: 60_000, maxRequests: 20, scope: 'application' },
  },
  async ({ body, principal }) => {
    try {
      const target = body.action === 'rollback' ? 'rollback' : {
        mode: body.mode!,
        guardPercent: body.guardPercent!,
      };
      const row = await updateGatewayRouting(
        requireTenantContext(principal),
        principal!.subject,
        target,
        body.gate,
      );
      return Response.json({ success: true, data: row });
    } catch (error) {
      if (error instanceof GatewayRoutingTransitionError) {
        throw new ApiProblem({
          status: 409,
          code: error.code,
          title: 'Gateway routing transition rejected',
          detail: error.message,
        });
      }
      throw error;
    }
  },
);
