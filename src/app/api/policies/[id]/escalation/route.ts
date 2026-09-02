/**
 * 策略升级配置API
 * 用于获取和更新策略的升级配置
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  emptyQuerySchema,
  jsonObjectResponseSchema,
} from '@/contracts/http/common';
import {
  escalationConfigSchema,
  policyParamsSchema,
} from '@/contracts/http/policies';
import { withLegacyApiSecurity, type AuthenticatedPrincipal } from '@/lib/api-security';
import { db } from '@/lib/db';
import { policyProfiles } from '@/storage/database/shared/schema';
import { and, eq } from 'drizzle-orm';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';

/**
 * GET - 获取策略升级配置
 */
async function getEscalationConfig(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  apiContext: { principal: AuthenticatedPrincipal | null },
) {
  try {
    const scope = requireTenantContext(apiContext.principal);
    const { id: policyId } = await params;

    const policies = await db
      .select({
        escalationEnabled: policyProfiles.escalationEnabled,
        escalationThreshold: policyProfiles.escalationThreshold,
        escalationTargetPolicyId: policyProfiles.escalationTargetPolicyId,
        deescalationThreshold: policyProfiles.deescalationThreshold,
        escalationCooldownMinutes: policyProfiles.escalationCooldownMinutes,
      })
      .from(policyProfiles)
      .where(and(
        eq(policyProfiles.id, policyId),
        scopePredicate(policyProfiles, scope),
      ))
      .limit(1);

    if (policies.length === 0) {
      return NextResponse.json(
        { success: false, error: '策略不存在' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: policies[0],
    });
  } catch {
    console.error('[策略升级配置API] GET失败');
    return NextResponse.json(
      { success: false, error: '获取配置失败' },
      { status: 500 }
    );
  }
}

/**
 * PUT - 更新策略升级配置
 */
async function updateEscalationConfig(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  apiContext: { principal: AuthenticatedPrincipal | null },
) {
  try {
    const scope = requireTenantContext(apiContext.principal);
    const { id: policyId } = await params;
    const body = await request.json();

    const {
      escalationEnabled,
      escalationThreshold,
      escalationTargetPolicyId,
      deescalationThreshold,
      escalationCooldownMinutes,
    } = body;

    // 验证参数
    if (escalationThreshold !== undefined && (escalationThreshold < 1 || escalationThreshold > 20)) {
      return NextResponse.json(
        { success: false, error: '升级阈值必须在1-20之间' },
        { status: 400 }
      );
    }

    if (deescalationThreshold !== undefined && (deescalationThreshold < 1 || deescalationThreshold > 10)) {
      return NextResponse.json(
        { success: false, error: '降级阈值必须在1-10之间' },
        { status: 400 }
      );
    }

    if (escalationCooldownMinutes !== undefined && (escalationCooldownMinutes < 0 || escalationCooldownMinutes > 1440)) {
      return NextResponse.json(
        { success: false, error: '冷却期必须在0-1440分钟之间，0表示满足条件立即降级' },
        { status: 400 }
      );
    }

    // 检查目标策略是否存在（如果指定了）
    if (escalationTargetPolicyId) {
      const targetPolicies = await db
        .select()
        .from(policyProfiles)
        .where(and(
          eq(policyProfiles.id, escalationTargetPolicyId),
          scopePredicate(policyProfiles, scope),
        ))
        .limit(1);

      if (targetPolicies.length === 0) {
        return NextResponse.json(
          { success: false, error: '目标策略不存在' },
          { status: 400 }
        );
      }

      // 不能升级到自己
      if (escalationTargetPolicyId === policyId) {
        return NextResponse.json(
          { success: false, error: '不能将策略升级到自身' },
          { status: 400 }
        );
      }
    }

    // 更新配置
    await db
      .update(policyProfiles)
      .set({
        escalationEnabled: escalationEnabled ?? false,
        escalationThreshold: escalationThreshold ?? 5,
        escalationTargetPolicyId: escalationTargetPolicyId ?? null,
        deescalationThreshold: deescalationThreshold ?? 1,
        escalationCooldownMinutes: escalationCooldownMinutes ?? 30,
        updatedAt: new Date(),
      })
      .where(and(
        eq(policyProfiles.id, policyId),
        scopePredicate(policyProfiles, scope),
      ));

    return NextResponse.json({
      success: true,
      message: '策略升级配置已更新',
    });
  } catch {
    console.error('[策略升级配置API] PUT失败');
    return NextResponse.json(
      { success: false, error: '更新配置失败' },
      { status: 500 }
    );
  }
}

export const GET = withLegacyApiSecurity(
  {
    permission: 'policy:read',
    paramsSchema: policyParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'policy.escalation.read',
    rateLimitPolicy: {
      id: 'policy-escalation-read',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'principal',
    },
  },
  getEscalationConfig,
);

export const PUT = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: policyParamsSchema,
    bodySchema: escalationConfigSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 16 * 1_024,
    auditEvent: 'policy.escalation.update',
    rateLimitPolicy: {
      id: 'policy-escalation-update',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  updateEscalationConfig,
);
