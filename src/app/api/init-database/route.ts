import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { db } from '@/lib/db';
import { initializeDatabase, initDefaultPolicy } from '@/lib/detection/init-database';
import { isRuntimeDatabaseInitializationAllowed } from '@/lib/platform/runtime-initialization';
import { detectionDimensions } from '@/storage/database/shared/schema';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';

const statusResponseSchema = z.object({
  success: z.literal(true),
  isInitialized: z.boolean(),
});

const initResponseSchema = z.object({
  success: z.literal(true),
  data: z.record(z.string(), z.unknown()),
});

function assertRuntimeInitializationAllowed(): void {
  if (!isRuntimeDatabaseInitializationAllowed()) {
    throw new ApiProblem({
      status: 404,
      code: 'RUNTIME_INITIALIZATION_DISABLED',
      title: 'Not found',
      detail: 'Runtime database initialization is disabled. Use the deployment migration job.',
    });
  }
}

export const POST = withApiSecurity(
  {
    permission: 'platform:settings:manage',
    responseSchema: initResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'platform.database.initialize',
    rateLimitPolicy: {
      id: 'database-initialize',
      windowMs: 60_000,
      maxRequests: 2,
      scope: 'principal',
    },
  },
  async ({ principal }) => {
    assertRuntimeInitializationAllowed();
    const scope = requireTenantContext(principal);
    const result = await initializeDatabase();
    if (!result.success) {
      throw new ApiProblem({
        status: 500,
        code: 'DATABASE_INITIALIZATION_FAILED',
        title: 'Initialization failed',
        detail: 'Database initialization did not complete successfully.',
      });
    }

    const policyResult = await initDefaultPolicy(scope);
    if (!policyResult.success) {
      throw new ApiProblem({
        status: 500,
        code: 'DEFAULT_POLICY_INITIALIZATION_FAILED',
        title: 'Initialization failed',
        detail: 'Default policy initialization did not complete successfully.',
      });
    }

    return Response.json({
      success: true as const,
      data: {
        dimensions: result.dimensions,
        rules: result.rules,
        whitelist: result.whitelist,
        policyId: policyResult.policyId,
      },
    });
  },
);

export const GET = withApiSecurity(
  {
    permission: 'platform:settings:manage',
    responseSchema: statusResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'platform.database.status',
    rateLimitPolicy: {
      id: 'database-status',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  async ({ principal }) => {
    const scope = requireTenantContext(principal);
    const dimensions = await db
      .select({ id: detectionDimensions.id })
      .from(detectionDimensions)
      .where(scopePredicate(detectionDimensions, scope))
      .limit(1);

    return Response.json({
      success: true as const,
      isInitialized: dimensions.length > 0,
    });
  },
);
