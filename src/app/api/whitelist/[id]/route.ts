import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  emptyQuerySchema,
  idParamsSchema,
  jsonObjectResponseSchema,
} from '@/contracts/http/common';
import { withLegacyApiSecurity } from '@/lib/api-security';
import { query, update, remove } from '@/lib/db';
import { compileSafeRegex } from '@/lib/detection/safe-regex';

const updateLegacyWhitelistSchema = z
  .object({
    dimensionId: z.string().min(1).max(128).nullable().optional(),
    pattern: z.string().min(1).max(4_096).optional(),
    matchType: z.enum(['exact', 'contains', 'prefix', 'suffix', 'regex']).optional(),
    caseSensitive: z.boolean().optional(),
    description: z.string().max(2_000).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  })
  .superRefine((value, context) => {
    if (value.matchType === 'regex' && value.pattern) {
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

interface RouteParams {
  params: Promise<{ id: string }>;
}

// 获取单个白名单规则
async function getLegacyWhitelistRule(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const result = await query('whitelist_rules', {
      filter: { id }
    });

    if (result.error || !result.data || (Array.isArray(result.data) && result.data.length === 0)) {
      return NextResponse.json(
        { success: false, error: '白名单规则不存在' },
        { status: 404 }
      );
    }

    const rule = Array.isArray(result.data) ? result.data[0] : result.data;
    return NextResponse.json({ success: true, data: rule });
  } catch (error) {
    console.error('获取白名单规则失败:', error);
    return NextResponse.json(
      { success: false, error: '获取白名单规则失败' },
      { status: 500 }
    );
  }
}

// 更新白名单规则
async function updateLegacyWhitelistRule(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { dimensionId, pattern, matchType, caseSensitive, description, enabled } = body;

    const updateData: Record<string, unknown> = {};
    if (dimensionId !== undefined) updateData.dimensionId = dimensionId;
    if (pattern !== undefined) updateData.pattern = pattern;
    if (matchType !== undefined) updateData.matchType = matchType;
    if (caseSensitive !== undefined) updateData.caseSensitive = caseSensitive;
    if (description !== undefined) updateData.description = description;
    if (enabled !== undefined) updateData.enabled = enabled;

    const result = await update('whitelist_rules', id, updateData);

    return NextResponse.json({ success: true, data: result.data });
  } catch (error) {
    console.error('更新白名单规则失败:', error);
    return NextResponse.json(
      { success: false, error: '更新白名单规则失败' },
      { status: 500 }
    );
  }
}

// 删除白名单规则
async function deleteLegacyWhitelistRule(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    await remove('whitelist_rules', id);

    return NextResponse.json({ success: true });
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
    paramsSchema: idParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'whitelist.legacy.read',
    rateLimitPolicy: {
      id: 'whitelist-legacy-read',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'principal',
    },
  },
  getLegacyWhitelistRule,
);

export const PUT = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: idParamsSchema,
    bodySchema: updateLegacyWhitelistSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 64 * 1_024,
    auditEvent: 'whitelist.legacy.update',
    rateLimitPolicy: {
      id: 'whitelist-legacy-update',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  updateLegacyWhitelistRule,
);

export const DELETE = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: idParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'whitelist.legacy.delete',
    rateLimitPolicy: {
      id: 'whitelist-legacy-delete',
      windowMs: 60_000,
      maxRequests: 10,
      scope: 'principal',
    },
  },
  deleteLegacyWhitelistRule,
);
