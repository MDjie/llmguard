import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { emptyQuerySchema, jsonObjectResponseSchema } from '@/contracts/http/common';
import { withLegacyApiSecurity, type AuthenticatedPrincipal } from '@/lib/api-security';
import { db } from '@/lib/db';
import { whitelistRules, policyProfiles } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { compileSafeRegex } from '@/lib/detection/safe-regex';
import { requireTenantContext, scopePredicate, type TenantScope } from '@/lib/tenancy';

const createLegacyWhitelistSchema = z
  .object({
    policyId: z.string().min(1).max(36).optional(),
    dimensionId: z.string().min(1).max(128).nullable().optional(),
    pattern: z.string().min(1).max(4_096),
    matchType: z
      .enum(['exact', 'contains', 'prefix', 'suffix', 'regex'])
      .default('contains'),
    caseSensitive: z.boolean().default(false),
    description: z.string().max(2_000).optional(),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, context) => {
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
  });

// 获取默认策略ID
async function getDefaultPolicyId(scope: TenantScope): Promise<string | null> {
  try {
    // 优先查找 is_default 为 true 的策略
    const defaultPolicies = await db.select()
      .from(policyProfiles)
      .where(and(
        eq(policyProfiles.isDefault, true),
        scopePredicate(policyProfiles, scope),
      ))
      .limit(1);
    
    if (defaultPolicies.length > 0) {
      return defaultPolicies[0].id;
    }
    
    // 如果没有默认策略，获取第一个策略
    const allPolicies = await db.select()
      .from(policyProfiles)
      .where(scopePredicate(policyProfiles, scope))
      .limit(1);
    
    if (allPolicies.length > 0) {
      return allPolicies[0].id;
    }
    
    return null;
  } catch (error) {
    console.error('获取默认策略失败:', error);
    return null;
  }
}

// GET: 获取所有白名单规则
async function getLegacyWhitelist(
  _request: NextRequest,
  _routeContext: unknown,
  context: { principal: AuthenticatedPrincipal | null },
) {
  try {
    const scope = requireTenantContext(context.principal);
    // 尝试从数据库获取白名单规则
    const rules = await db.select().from(whitelistRules)
      .where(scopePredicate(whitelistRules, scope));

    // 如果数据库为空，返回友好提示
    if (rules.length === 0) {
      // 检查是否需要初始化
      return NextResponse.json({ 
        success: true, 
        data: [],
        message: '白名单规则为空。请访问 /api/init-database 初始化数据库，或在白名单管理页面添加规则。'
      });
    }

    return NextResponse.json({ success: true, data: rules });
  } catch (error) {
    console.error('获取白名单规则失败:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: '获取白名单规则失败，请检查数据库连接。请确保已运行数据库迁移。' 
      },
      { status: 500 }
    );
  }
}

// POST: 创建白名单规则
async function createLegacyWhitelist(
  request: NextRequest,
  _routeContext: unknown,
  context: { principal: AuthenticatedPrincipal | null },
) {
  try {
    const scope = requireTenantContext(context.principal);
    const body = await request.json();
    let policyId = body.policyId as string | null | undefined;
    const {
      dimensionId,
      pattern,
      matchType,
      caseSensitive,
      description,
      enabled,
    } = body;

    if (!pattern) {
      return NextResponse.json(
        { success: false, error: '缺少必要参数: pattern' },
        { status: 400 }
      );
    }

    // 如果没有传入 policyId，从数据库获取默认策略
    if (!policyId) {
      policyId = await getDefaultPolicyId(scope);
      if (!policyId) {
        return NextResponse.json(
          { success: false, error: '未找到可用策略，请先创建策略' },
          { status: 400 }
        );
      }
    }
    const [policy] = await db.select({ id: policyProfiles.id }).from(policyProfiles).where(and(
      eq(policyProfiles.id, policyId),
      scopePredicate(policyProfiles, scope),
    )).limit(1);
    if (!policy) {
      return NextResponse.json(
        { success: false, error: '策略不属于当前应用' },
        { status: 404 },
      );
    }

    // 使用 gen_random_uuid() 生成 UUID
    const result = await db.insert(whitelistRules).values({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      policyId,
      dimensionId: dimensionId || null,
      pattern,
      matchType: matchType || 'contains',
      caseSensitive: caseSensitive ?? false,
      description: description || null,
      enabled: enabled ?? true,
    }).returning();

    return NextResponse.json({ success: true, data: result[0] });
  } catch (error) {
    console.error('创建白名单规则失败:', error);
    return NextResponse.json(
      { success: false, error: '创建白名单规则失败' },
      { status: 500 }
    );
  }
}

export const GET = withLegacyApiSecurity(
  {
    permission: 'policy:read',
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'whitelist.legacy.list',
    rateLimitPolicy: {
      id: 'whitelist-legacy-list',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'principal',
    },
  },
  getLegacyWhitelist,
);

export const POST = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    bodySchema: createLegacyWhitelistSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 64 * 1_024,
    auditEvent: 'whitelist.legacy.create',
    rateLimitPolicy: {
      id: 'whitelist-legacy-create',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  createLegacyWhitelist,
);
