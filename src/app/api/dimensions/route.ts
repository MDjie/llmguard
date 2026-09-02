import { z } from 'zod';
import { withApiSecurity } from '@/lib/api-security';
import { db } from "@/storage/database/shared/db";
import { detectionDimensions, detectionRules } from "@/storage/database/shared/schema";
import { and, eq } from "drizzle-orm";
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';

const createDimensionSchema = z
  .object({
    code: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
    name: z.string().trim().min(1).max(128),
    description: z.string().max(2_000).default(''),
    category: z.string().trim().min(1).max(64).default('custom'),
    weight: z.number().positive().max(10).default(1),
    priority: z.number().int().min(0).max(10_000).default(100),
    enabled: z.boolean().default(true),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const listResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(z.record(z.string(), z.unknown())),
});

const itemResponseSchema = z.object({
  success: z.literal(true),
  data: z.record(z.string(), z.unknown()),
});

// 确保此路由在 Node.js 运行时执行
export const runtime = 'nodejs';

// 获取所有检测维度
export const GET = withApiSecurity(
  {
    permission: 'policy:read',
    responseSchema: listResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'dimension.list',
    rateLimitPolicy: {
      id: 'dimension-list',
      windowMs: 60_000,
      maxRequests: 120,
      scope: 'principal',
    },
  },
  async ({ principal }) => {
    const scope = requireTenantContext(principal);
    const dimensions = await db
      .select({
        id: detectionDimensions.id,
        code: detectionDimensions.code,
        name: detectionDimensions.name,
        description: detectionDimensions.description,
        category: detectionDimensions.category,
        weight: detectionDimensions.weight,
        priority: detectionDimensions.priority,
        enabled: detectionDimensions.enabled,
        isSystem: detectionDimensions.isSystem,
        config: detectionDimensions.config,
        createdAt: detectionDimensions.createdAt,
        updatedAt: detectionDimensions.updatedAt,
      })
      .from(detectionDimensions)
      .where(scopePredicate(detectionDimensions, scope));

    // 获取每个维度的规则数量
    const dimensionsWithCounts = await Promise.all(
      dimensions.map(async (dim) => {
          const rules = await db
            .select({ id: detectionRules.id })
            .from(detectionRules)
            .where(and(
              scopePredicate(detectionRules, scope),
              eq(detectionRules.dimensionId, dim.id),
            ));
          
          return {
            ...dim,
            ruleCount: rules.length,
            groupCount: 0,
          };
      })
    );

    return Response.json({
      success: true as const,
      data: dimensionsWithCounts,
    });
  },
);

// 创建新的检测维度
export const POST = withApiSecurity(
  {
    permission: 'policy:manage',
    bodySchema: createDimensionSchema,
    responseSchema: itemResponseSchema,
    maxBodyBytes: 64 * 1_024,
    auditEvent: 'dimension.create',
    rateLimitPolicy: {
      id: 'dimension-create',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  async ({ body, principal }) => {
    const scope = requireTenantContext(principal);
    const { code, name, description, category, weight, priority, enabled, config } = body;

    const [newDimension] = await db
      .insert(detectionDimensions)
      .values({
        tenantId: scope.tenantId,
        applicationId: scope.applicationId,
        code,
        name,
        description,
        category,
        weight: String(weight),
        priority,
        enabled,
        isSystem: false,
        config,
      })
      .returning();

    return Response.json({
      success: true as const,
      data: {
        ...newDimension,
        ruleCount: 0,
        groupCount: 0,
      },
    });
  },
);
