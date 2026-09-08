import { NextRequest, NextResponse } from 'next/server';
import { emptyQuerySchema, jsonObjectResponseSchema } from '@/contracts/http/common';
import {
  createTestCaseSchema,
  testCaseDeleteQuerySchema,
  updateTestCaseSchema,
} from '@/contracts/http/test-cases';
import { withLegacyApiSecurity } from '@/lib/api-security';
import { db } from '@/storage/database/shared/db';
import { testCases } from '@/storage/database/shared/schema';
import { getCurrentTenantScope } from '@/lib/tenancy/runtime';
import { scopePredicate } from '@/lib/tenancy';
import { desc } from 'drizzle-orm';
import { getDb } from '@/lib/db';

async function getTestCases() {
  try {
    const scope = getCurrentTenantScope();
    if (!scope) throw new Error('TENANT_SCOPE_REQUIRED');
    const data = await db.select().from(testCases).where(scopePredicate(testCases, scope)).orderBy(desc(testCases.createdAt));

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('Error fetching test cases:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch test cases' },
      { status: 500 }
    );
  }
}

async function createTestCase(request: NextRequest) {
  try {
    const body = await request.json();
    const { title, description, category, inputText, outputText, expectedAction, expectedDimensions, expectedScoreMin, expectedScoreMax, severity, enabled } = body;

    if (!title || !inputText) {
      return NextResponse.json(
        { success: false, error: '标题和输入文本不能为空' },
        { status: 400 }
      );
    }

    const client = getDb();

    const result = await client
      .from('test_cases')
      .insert({
        title,
        description: description || '',
        category: category || 'normal_qa',
        inputText,
        outputText: outputText || null,
        expectedAction: expectedAction || 'allow',
        expectedDimensions: expectedDimensions || [],
        expectedScoreMin: expectedScoreMin === undefined ? null : String(expectedScoreMin),
        expectedScoreMax: expectedScoreMax === undefined ? null : String(expectedScoreMax),
        severity: severity || 'medium',
        enabled: enabled ?? true,
      });

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: result.data?.[0],
    });
  } catch (error) {
    console.error('Error creating test case:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to create test case' },
      { status: 500 }
    );
  }
}

async function updateTestCase(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, title, description, category, inputText, outputText, expectedAction, expectedDimensions, expectedScoreMin, expectedScoreMax, severity, enabled } = body;

    if (!id) {
      return NextResponse.json(
        { success: false, error: '测试用例ID不能为空' },
        { status: 400 }
      );
    }

    const client = getDb();

    const result = await client
      .from('test_cases')
      .update({
        title,
        description,
        category,
        inputText,
        outputText,
        expectedAction,
        expectedDimensions,
        expectedScoreMin: expectedScoreMin === undefined ? undefined : String(expectedScoreMin),
        expectedScoreMax: expectedScoreMax === undefined ? undefined : String(expectedScoreMax),
        severity,
        enabled,
      })
      .eq('id', id);

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: result.data?.[0],
    });
  } catch (error) {
    console.error('Error updating test case:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to update test case' },
      { status: 500 }
    );
  }
}

async function deleteTestCase(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { success: false, error: '测试用例ID不能为空' },
        { status: 400 }
      );
    }

    const client = getDb();

    const result = await client
      .from('test_cases')
      .delete()
      .eq('id', id);

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: '测试用例删除成功',
    });
  } catch (error) {
    console.error('Error deleting test case:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to delete test case' },
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
    auditEvent: 'test-case.list',
    rateLimitPolicy: {
      id: 'test-case-list',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'principal',
    },
  },
  getTestCases,
);

export const POST = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    bodySchema: createTestCaseSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 128 * 1_024,
    auditEvent: 'test-case.create',
    rateLimitPolicy: {
      id: 'test-case-create',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  createTestCase,
);

export const PUT = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    bodySchema: updateTestCaseSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 128 * 1_024,
    auditEvent: 'test-case.update',
    rateLimitPolicy: {
      id: 'test-case-update',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  updateTestCase,
);

export const DELETE = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    querySchema: testCaseDeleteQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'test-case.delete',
    rateLimitPolicy: {
      id: 'test-case-delete',
      windowMs: 60_000,
      maxRequests: 20,
      scope: 'principal',
    },
  },
  deleteTestCase,
);
