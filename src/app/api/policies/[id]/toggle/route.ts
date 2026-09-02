import { NextRequest, NextResponse } from 'next/server';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { policyParamsSchema, togglePolicySchema } from '@/contracts/http/policies';
import { withLegacyApiSecurity } from '@/lib/api-security';
import { getDb } from '@/lib/db';
import { clearPolicyCache } from '@/lib/detection/dynamic-engine';

// 启用/禁用策略
async function togglePolicy(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive } = body;

    if (typeof isActive !== 'boolean') {
      return NextResponse.json(
        { success: false, error: 'isActive 必须是布尔值' },
        { status: 400 }
      );
    }

    const client = getDb();

    const { error } = await client
      .from('policy_profiles')
      .update({ is_active: isActive })
      .eq('id', id);

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }

    // 清除检测缓存
    clearPolicyCache(id);

    return NextResponse.json({
      success: true,
      message: isActive ? '策略已启用' : '策略已禁用',
    });
  } catch (error) {
    console.error('Error toggling policy:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to toggle policy' },
      { status: 500 }
    );
  }
}

export const PUT = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: policyParamsSchema,
    bodySchema: togglePolicySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 8 * 1_024,
    auditEvent: 'policy.toggle',
    rateLimitPolicy: {
      id: 'policy-toggle',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  togglePolicy,
);
