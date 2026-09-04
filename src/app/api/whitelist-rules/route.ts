import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { withLegacyApiSecurity, type AuthenticatedPrincipal } from '@/lib/api-security';
import { db } from '@/lib/db';
import { whitelistRules, whitelistRulePolicies, policyProfiles, detectionDimensions } from '@/lib/db';
import { and, eq, sql } from 'drizzle-orm';
import { compileSafeRegex } from '@/lib/detection/safe-regex';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';

const whitelistRuleFields = {
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2_000).optional(),
  policyScope: z.enum(['all', 'specific']),
  policyIds: z.array(z.string().min(1).max(36)).max(100).default([]),
  dimensionScope: z.enum(['all', 'specific']),
  dimensionCodes: z
    .array(z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/))
    .max(100)
    .default([]),
  targetRuleIds: z
    .array(z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/))
    .min(1)
    .max(5_000)
    .default([]),
  directions: z
    .array(z.enum([
      'INPUT',
      'OUTPUT_COMPLETE',
      'OUTPUT_CHUNK',
      'RAG_INGEST',
      'RAG_CONTEXT',
      'TOOL_REQUEST',
      'TOOL_RESULT',
    ]))
    .min(1)
    .max(7)
    .default([]),
  validFrom: z.string().datetime({ offset: true }).optional(),
  expiresAt: z.string().datetime({ offset: true }),
  priority: z.number().int().min(0).max(10_000).default(100),
  pattern: z.string().trim().min(1).max(4_096),
  matchType: z.enum(['exact', 'contains', 'prefix', 'suffix', 'regex']),
  caseSensitive: z.boolean().default(false),
  enabled: z.literal(false).default(false),
};

function validateWhitelistScope(
  value: {
    policyScope: 'all' | 'specific';
    policyIds: string[];
    dimensionScope: 'all' | 'specific';
    dimensionCodes: string[];
    targetRuleIds: string[];
    directions: Array<'INPUT' | 'OUTPUT_COMPLETE' | 'OUTPUT_CHUNK' | 'RAG_INGEST' | 'RAG_CONTEXT' | 'TOOL_REQUEST' | 'TOOL_RESULT'>;
    validFrom?: string;
    expiresAt: string;
    matchType: 'exact' | 'contains' | 'prefix' | 'suffix' | 'regex';
    pattern: string;
    caseSensitive: boolean;
  },
  context: z.RefinementCtx,
): void {
  if (value.policyScope === 'specific' && value.policyIds.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['policyIds'],
      message: 'At least one policy is required for a specific policy scope',
    });
  }
  if (value.dimensionScope !== 'specific' || value.dimensionCodes.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['dimensionScope'],
      message: 'Whitelist rules must target one or more explicit dimensions',
    });
  }
  if (new Set(value.targetRuleIds).size !== value.targetRuleIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['targetRuleIds'],
      message: 'Target rule IDs must be unique',
    });
  }
  if (new Set(value.directions).size !== value.directions.length) {
    context.addIssue({
      code: 'custom',
      path: ['directions'],
      message: 'Directions must be unique',
    });
  }
  if (value.targetRuleIds.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['targetRuleIds'],
      message: 'Whitelist rules must target one or more explicit rules',
    });
  }
  if (value.directions.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['directions'],
      message: 'Whitelist rules must target one or more explicit directions',
    });
  }
  const validFrom = value.validFrom ? Date.parse(value.validFrom) : Date.now();
  const expiresAt = Date.parse(value.expiresAt);
  if (expiresAt <= validFrom || expiresAt <= Date.now()) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Expiry must be after the effective time and in the future' });
  }
  if (value.matchType === 'regex') {
    try {
      compileSafeRegex(value.pattern, value.caseSensitive ? '' : 'i');
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['pattern'],
        message: 'The regular expression is invalid or unsupported',
      });
    }
  }
}

const createWhitelistRuleSchema = z
  .object(whitelistRuleFields)
  .strict()
  .superRefine(validateWhitelistScope);
const updateWhitelistRuleSchema = z
  .object({ id: z.string().min(1).max(128), ...whitelistRuleFields })
  .strict()
  .superRefine(validateWhitelistScope);
type CreateWhitelistRuleInput = z.infer<typeof createWhitelistRuleSchema>;
type UpdateWhitelistRuleInput = z.infer<typeof updateWhitelistRuleSchema>;
const listQuerySchema = z
  .object({
    policyId: z.string().min(1).max(36).optional(),
  })
  .strict();
const deleteQuerySchema = z
  .object({
    id: z.string().min(1).max(128),
  })
  .strict();

// GET: 获取所有白名单规则（包含策略绑定信息）
async function getWhitelistRules(
  request: NextRequest,
  _routeContext: unknown,
  context: { principal: AuthenticatedPrincipal | null },
) {
  try {
    const scope = requireTenantContext(context.principal);
    const { searchParams } = new URL(request.url);
    const policyId = searchParams.get('policyId');

    // 获取所有白名单规则
    const rules = await db.select().from(whitelistRules)
      .where(scopePredicate(whitelistRules, scope))
      .orderBy(sql`${whitelistRules.priority} DESC`);

    // 获取所有策略绑定
    const policyBindings = await db.select().from(whitelistRulePolicies)
      .where(scopePredicate(whitelistRulePolicies, scope));

    // 获取所有策略信息
    const policies = await db.select().from(policyProfiles)
      .where(scopePredicate(policyProfiles, scope));

    // 获取所有维度信息
    const dimensions = await db.select().from(detectionDimensions)
      .where(scopePredicate(detectionDimensions, scope));

    // 组装返回数据
    const rulesWithBindings = rules.map(rule => {
      const bindings = policyBindings.filter(b => b.whitelistRuleId === rule.id);
      const boundPolicyIds = bindings.map(b => b.policyId);
      const boundPolicies = policies.filter(p => boundPolicyIds.includes(p.id));

      // 获取维度名称
      const dimCodes = rule.dimensionCodes as string[] || [];
      const dimNames = dimCodes.map(code => {
        const dim = dimensions.find(d => d.code === code);
        return dim ? dim.name : code;
      });

      return {
        ...rule,
        policyIds: boundPolicyIds,
        policyNames: boundPolicies.map(p => p.name),
        dimensionNames: dimNames,
      };
    });

    // 如果指定了策略ID，过滤出对该策略生效的白名单
    let filteredRules = rulesWithBindings;
    if (policyId) {
      filteredRules = rulesWithBindings.filter(rule => 
        rule.policyScope === 'all' || rule.policyIds?.includes(policyId)
      );
    }

    return NextResponse.json({ success: true, data: filteredRules });
  } catch (error) {
    console.error('获取白名单规则失败:', error);
    return NextResponse.json(
      { success: false, error: '获取白名单规则失败' },
      { status: 500 }
    );
  }
}

// POST: 创建白名单规则
async function createWhitelistRule(
  request: NextRequest,
  _routeContext: unknown,
  context: { principal: AuthenticatedPrincipal | null },
) {
  try {
    const scope = requireTenantContext(context.principal);
    const body = (await request.json()) as CreateWhitelistRuleInput;
    const {
      name,
      description,
      policyScope,
      policyIds = [],
      dimensionScope,
      dimensionCodes = [],
      targetRuleIds = [],
      directions = [],
      validFrom,
      expiresAt,
      priority = 100,
      pattern,
      matchType,
      caseSensitive
    } = body;

    const newRule = await db.transaction(async (transaction) => {
      const [created] = await transaction.insert(whitelistRules).values({
        tenantId: scope.tenantId,
        applicationId: scope.applicationId,
        name,
        description: description || null,
        policyScope,
        dimensionScope,
        dimensionCodes,
        targetRuleIds,
        directions,
        validFrom: validFrom ? new Date(validFrom) : new Date(),
        expiresAt: new Date(expiresAt),
        approvalStatus: 'pending',
        approvedBy: null,
        approvedAt: null,
        priority,
        pattern,
        matchType,
        caseSensitive,
        enabled: false,
      }).returning();
      if (!created) throw new Error('Whitelist rule insert returned no row');
      if (policyScope === 'specific' && policyIds.length > 0) {
        await transaction.insert(whitelistRulePolicies).values(policyIds.map(policyId => ({
          tenantId: scope.tenantId,
          applicationId: scope.applicationId,
          whitelistRuleId: created.id,
          policyId,
        })));
      }
      return created;
    });

    return NextResponse.json({ success: true, data: newRule });
  } catch (error) {
    console.error('创建白名单规则失败:', error);
    return NextResponse.json(
      { success: false, error: '创建白名单规则失败' },
      { status: 500 }
    );
  }
}

// PUT: 更新白名单规则
async function updateWhitelistRule(
  request: NextRequest,
  _routeContext: unknown,
  context: { principal: AuthenticatedPrincipal | null },
) {
  try {
    const scope = requireTenantContext(context.principal);
    const body = (await request.json()) as UpdateWhitelistRuleInput;
    const {
      id,
      name,
      description,
      policyScope,
      policyIds = [],
      dimensionScope,
      dimensionCodes = [],
      targetRuleIds = [],
      directions = [],
      validFrom,
      expiresAt,
      priority,
      pattern,
      matchType,
      caseSensitive
    } = body;

    const updatedRule = await db.transaction(async (transaction) => {
      const [updated] = await transaction.update(whitelistRules)
        .set({
          name,
          description: description || null,
          policyScope,
          dimensionScope,
          dimensionCodes,
          targetRuleIds,
          directions,
          validFrom: validFrom ? new Date(validFrom) : new Date(),
          expiresAt: new Date(expiresAt),
          approvalStatus: 'pending',
          approvedBy: null,
          approvedAt: null,
          priority,
          pattern,
          matchType,
          caseSensitive,
          enabled: false,
          updatedAt: new Date(),
        })
        .where(and(
          eq(whitelistRules.id, id),
          scopePredicate(whitelistRules, scope),
        ))
        .returning();
      if (!updated) return undefined;
      await transaction.delete(whitelistRulePolicies)
        .where(and(
          eq(whitelistRulePolicies.whitelistRuleId, id),
          scopePredicate(whitelistRulePolicies, scope),
        ));
      if (policyScope === 'specific' && policyIds.length > 0) {
        await transaction.insert(whitelistRulePolicies).values(policyIds.map(policyId => ({
          tenantId: scope.tenantId,
          applicationId: scope.applicationId,
          whitelistRuleId: id,
          policyId,
        })));
      }
      return updated;
    });

    if (!updatedRule) {
      return NextResponse.json(
        { success: false, error: '白名单规则不存在' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, data: updatedRule });
  } catch (error) {
    console.error('更新白名单规则失败:', error);
    return NextResponse.json(
      { success: false, error: '更新白名单规则失败' },
      { status: 500 }
    );
  }
}

// DELETE: 删除白名单规则
async function deleteWhitelistRule(
  request: NextRequest,
  _routeContext: unknown,
  context: { principal: AuthenticatedPrincipal | null },
) {
  try {
    const scope = requireTenantContext(context.principal);
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { success: false, error: '缺少白名单ID' },
        { status: 400 }
      );
    }

    const deletedRule = await db.transaction(async (transaction) => {
      await transaction.delete(whitelistRulePolicies)
        .where(and(
          eq(whitelistRulePolicies.whitelistRuleId, id),
          scopePredicate(whitelistRulePolicies, scope),
        ));
      const [deleted] = await transaction.delete(whitelistRules)
        .where(and(
          eq(whitelistRules.id, id),
          scopePredicate(whitelistRules, scope),
        ))
        .returning();
      return deleted;
    });

    if (!deletedRule) {
      return NextResponse.json(
        { success: false, error: '白名单规则不存在' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, message: '删除成功' });
  } catch (error) {
    console.error('删除白名单规则失败:', error);
    return NextResponse.json(
      { success: false, error: '删除白名单规则失败' },
      { status: 500 }
    );
  }
}

export const GET = withLegacyApiSecurity(
  {
    permission: 'policy:read',
    querySchema: listQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'whitelist.list',
    rateLimitPolicy: {
      id: 'whitelist-list',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'principal',
    },
  },
  getWhitelistRules,
);

export const POST = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    bodySchema: createWhitelistRuleSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 64 * 1_024,
    auditEvent: 'whitelist.create',
    rateLimitPolicy: {
      id: 'whitelist-create',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  createWhitelistRule,
);

export const PUT = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    bodySchema: updateWhitelistRuleSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 64 * 1_024,
    auditEvent: 'whitelist.update',
    rateLimitPolicy: {
      id: 'whitelist-update',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  updateWhitelistRule,
);

export const DELETE = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    querySchema: deleteQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'whitelist.delete',
    rateLimitPolicy: {
      id: 'whitelist-delete',
      windowMs: 60_000,
      maxRequests: 10,
      scope: 'principal',
    },
  },
  deleteWhitelistRule,
);
