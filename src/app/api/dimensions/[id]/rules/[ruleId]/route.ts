import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  dimensionRuleParamsSchema,
  emptyQuerySchema,
  jsonObjectResponseSchema,
} from '@/contracts/http/common';
import { withLegacyApiSecurity } from '@/lib/api-security';
import { query, update, remove } from '@/lib/db';
import { clearPolicyCache } from '@/lib/detection/dynamic-engine';

const updateRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    pattern: z.string().max(4_096).optional(),
    matchType: z.enum(['exact', 'contains', 'prefix', 'suffix', 'regex']).optional(),
    caseSensitive: z.boolean().optional(),
    score: z.number().int().min(0).max(100).optional(),
    confidence: z.number().min(0).max(1).optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    enabled: z.boolean().optional(),
    description: z.string().max(2_000).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    groupId: z.string().max(128).nullable().optional(),
    suggestion: z.string().max(2_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  });

// 获取单个规则详情
async function getRule(
  request: Request,
  { params }: { params: Promise<{ id: string; ruleId: string }> }
) {
  try {
    const { id, ruleId } = await params;

    const result = await query('detection_rules', {
      filter: { id: ruleId, dimensionId: id },
      single: true
    });

    if (result.error || !result.data) {
      return NextResponse.json(
        { success: false, error: '规则不存在' },
        { status: 404 }
      );
    }

    const rule = Array.isArray(result.data) ? result.data[0] : result.data;
    return NextResponse.json({ success: true, data: rule });
  } catch (error) {
    console.error('获取规则详情失败:', error);
    return NextResponse.json(
      { success: false, error: '获取规则详情失败' },
      { status: 500 }
    );
  }
}

// 更新规则
async function updateRule(
  request: Request,
  { params }: { params: Promise<{ id: string; ruleId: string }> }
) {
  try {
    const { id, ruleId } = await params;
    const body = await request.json();

    // 检查规则是否存在
    const existing = await query('detection_rules', {
      filter: { id: ruleId, dimensionId: id },
      single: true
    });

    if (existing.error || !existing.data) {
      return NextResponse.json(
        { success: false, error: '规则不存在' },
        { status: 404 }
      );
    }

    const updateData: Record<string, unknown> = {};
    
    if (body.name !== undefined) updateData.name = body.name;
    if (body.pattern !== undefined) updateData.pattern = body.pattern;
    if (body.matchType !== undefined) updateData.match_type = body.matchType;
    if (body.caseSensitive !== undefined) updateData.case_sensitive = body.caseSensitive;
    if (body.score !== undefined) updateData.score = body.score;
    if (body.confidence !== undefined) updateData.confidence = body.confidence;
    if (body.priority !== undefined) updateData.priority = body.priority;
    if (body.enabled !== undefined) updateData.enabled = body.enabled;
    if (body.description !== undefined) updateData.description = body.description;
    if (body.config !== undefined) updateData.config = body.config;
    if (body.groupId !== undefined) updateData.group_id = body.groupId;
    if (body.suggestion !== undefined) updateData.suggestion = body.suggestion;

    const updated = await update('detection_rules', ruleId, updateData);

    // 清除检测缓存
    clearPolicyCache();

    return NextResponse.json({ success: true, data: updated.data });
  } catch (error) {
    console.error('更新规则失败:', error);
    return NextResponse.json(
      { success: false, error: '更新规则失败' },
      { status: 500 }
    );
  }
}

// 删除规则
async function deleteRule(
  request: Request,
  { params }: { params: Promise<{ id: string; ruleId: string }> }
) {
  try {
    const { id, ruleId } = await params;

    // 检查规则是否存在
    const existing = await query('detection_rules', {
      filter: { id: ruleId, dimensionId: id },
      single: true
    });

    if (existing.error || !existing.data) {
      return NextResponse.json(
        { success: false, error: '规则不存在' },
        { status: 404 }
      );
    }

    await remove('detection_rules', ruleId);

    // 清除检测缓存
    clearPolicyCache();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('删除规则失败:', error);
    return NextResponse.json(
      { success: false, error: '删除规则失败' },
      { status: 500 }
    );
  }
}

export const GET = withLegacyApiSecurity(
  {
    permission: 'policy:read',
    paramsSchema: dimensionRuleParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'rule.read',
    rateLimitPolicy: {
      id: 'rule-read',
      windowMs: 60_000,
      maxRequests: 120,
      scope: 'principal',
    },
  },
  getRule,
);

export const PUT = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: dimensionRuleParamsSchema,
    bodySchema: updateRuleSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 64 * 1_024,
    auditEvent: 'rule.update',
    rateLimitPolicy: {
      id: 'rule-update',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'principal',
    },
  },
  updateRule,
);

export const DELETE = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: dimensionRuleParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'rule.delete',
    rateLimitPolicy: {
      id: 'rule-delete',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  deleteRule,
);
