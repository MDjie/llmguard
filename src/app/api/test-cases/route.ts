import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET() {
  try {
    const client = getDb();
    
    const result = await client
      .from('test_cases')
      .select()
      .order('created_at', { ascending: false });

    if (result.error) {
      return NextResponse.json(
        { success: false, error: `Failed to fetch test cases: ${result.error}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: result.data || [],
    });
  } catch (error) {
    console.error('Error fetching test cases:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch test cases' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { title, description, category, inputText, outputText, expectedAction, expectedDimensions, severity, enabled } = body;

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

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, title, description, category, inputText, outputText, expectedAction, expectedDimensions, severity, enabled } = body;

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

export async function DELETE(request: NextRequest) {
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
