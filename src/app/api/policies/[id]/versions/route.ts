import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

// 获取策略版本历史
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const client = getDb();

    const { data, error } = await client
      .from('policy_versions')
      .select()
      .eq('policy_id', id)
      .order('version', { ascending: false })
      .limit(20);

    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: data || [],
    });
  } catch (error) {
    console.error('Error fetching versions:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch versions' },
      { status: 500 }
    );
  }
}
