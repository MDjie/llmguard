import { NextRequest, NextResponse } from 'next/server';
import { emptyQuerySchema, jsonObjectResponseSchema } from '@/contracts/http/common';
import {
  testCaseParamsSchema,
  updateTestCaseByIdSchema,
} from '@/contracts/http/test-cases';
import { withLegacyApiSecurity } from '@/lib/api-security';
import { getDb } from '@/lib/db';

async function getTestCase(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const client = getDb();

    const { data, error } = await client
      .from('test_cases')
      .select()
      .eq('id', id)
      .single();

    if (error) {
      return NextResponse.json(
        { success: false, error: '测试用例不存在' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('Error fetching test case:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch test case' },
      { status: 500 }
    );
  }
}

async function updateTestCase(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { title, description, category, inputText, outputText, expectedAction, expectedDimensions, expectedScoreMin, expectedScoreMax, severity, enabled } = body;

    const client = getDb();

    const updateData: Record<string, unknown> = {};
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (category !== undefined) updateData.category = category;
    if (inputText !== undefined) updateData.inputText = inputText;
    if (outputText !== undefined) updateData.outputText = outputText;
    if (expectedAction !== undefined) updateData.expectedAction = expectedAction;
    if (expectedDimensions !== undefined) updateData.expectedDimensions = expectedDimensions;
    if (expectedScoreMin !== undefined) updateData.expectedScoreMin = expectedScoreMin;
    if (expectedScoreMax !== undefined) updateData.expectedScoreMax = expectedScoreMax;
    if (severity !== undefined) updateData.severity = severity;
    if (enabled !== undefined) updateData.enabled = enabled;

    const result = await client
      .from('test_cases')
      .update(updateData)
      .eq('id', id)
      .select();

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error.message || '更新失败' },
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

async function deleteTestCase(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const client = getDb();

    const result = await client
      .from('test_cases')
      .delete()
      .eq('id', id);

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error.message || '删除失败' },
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
    paramsSchema: testCaseParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'test-case.read',
    rateLimitPolicy: {
      id: 'test-case-read',
      windowMs: 60_000,
      maxRequests: 60,
      scope: 'principal',
    },
  },
  getTestCase,
);

export const PUT = withLegacyApiSecurity(
  {
    permission: 'policy:manage',
    paramsSchema: testCaseParamsSchema,
    bodySchema: updateTestCaseByIdSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 128 * 1_024,
    auditEvent: 'test-case.update-by-id',
    rateLimitPolicy: {
      id: 'test-case-update-by-id',
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
    paramsSchema: testCaseParamsSchema,
    querySchema: emptyQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'test-case.delete-by-id',
    rateLimitPolicy: {
      id: 'test-case-delete-by-id',
      windowMs: 60_000,
      maxRequests: 20,
      scope: 'principal',
    },
  },
  deleteTestCase,
);
