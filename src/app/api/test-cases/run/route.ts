import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { DetectionOrchestrator } from '@/lib/llm/orchestrator';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { policyId, testCaseIds } = body;

    const client = getDb();

    // 获取测试用例
    let query = client
      .from('test_cases')
      .select()
      .eq('enabled', true);

    if (testCaseIds && testCaseIds.length > 0) {
      query = query.in('id', testCaseIds);
    }

    const { data: testCases, error: testCasesError } = await query;

    if (testCasesError) {
      return NextResponse.json(
        { success: false, error: '获取测试用例失败' },
        { status: 500 }
      );
    }

    if (!testCases || testCases.length === 0) {
      return NextResponse.json(
        { success: false, error: '没有找到可运行的测试用例' },
        { status: 404 }
      );
    }

    // 获取策略配置
    let policy;
    if (policyId) {
      const { data, error } = await client
        .from('policy_profiles')
        .select()
        .eq('id', policyId)
        .single();
      
      if (error || !data) {
        return NextResponse.json(
          { success: false, error: '策略配置不存在' },
          { status: 404 }
        );
      }
      policy = data;
    } else {
      const { data, error } = await client
        .from('policy_profiles')
        .select()
        .eq('is_default', true)
        .single();
      
      if (error || !data) {
        return NextResponse.json(
          { success: false, error: '未找到默认策略配置' },
          { status: 404 }
        );
      }
      policy = data;
    }

    // 获取策略规则
    const { data: rules, error: rulesError } = await client
      .from('policy_rules')
      .select()
      .eq('policy_id', policy.id)
      .eq('enabled', true);

    if (rulesError) {
      return NextResponse.json(
        { success: false, error: '获取策略规则失败' },
        { status: 500 }
      );
    }

    // 获取关键词规则
    const { data: keywords, error: keywordsError } = await client
      .from('keyword_rules')
      .select()
      .eq('policy_id', policy.id)
      .eq('enabled', true);

    if (keywordsError) {
      console.error('获取关键词规则失败:', keywordsError);
    }

    // 创建评估任务
    const { data: evaluationRun, error: runError } = await client
      .from('evaluation_runs')
      .insert({
        policy_id: policy.id,
        test_case_ids: testCases.map(tc => tc.id),
        total_cases: testCases.length,
        status: 'running',
      })
      .select()
      .single();

    if (runError) {
      return NextResponse.json(
        { success: false, error: '创建评估任务失败' },
        { status: 500 }
      );
    }

    // 执行检测
    const orchestrator = new DetectionOrchestrator();
    const results = [];
    let correctCount = 0;
    let wrongCount = 0;
    let totalScore = 0;

    for (const testCase of testCases) {
      const result = await orchestrator.detect(testCase.input_text, 'input', {
        ...policy,
        rules: rules || [],
        keywords: keywords || [],
      });

      const isCorrect = result.action === testCase.expected_action;
      if (isCorrect) {
        correctCount++;
      } else {
        wrongCount++;
      }
      totalScore += result.overallScore;

      // 保存评估结果
      await client
        .from('evaluation_results')
        .insert({
          run_id: evaluationRun.id,
          test_case_id: testCase.id,
          actual_action: result.action,
          actual_score: result.overallScore,
          is_correct: isCorrect,
          expected_action: testCase.expected_action,
          findings: result.findings,
        });

      results.push({
        testCase,
        result,
        isCorrect,
      });
    }

    // 更新评估任务状态
    await client
      .from('evaluation_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        correct_count: correctCount,
        wrong_count: wrongCount,
        accuracy: (correctCount / testCases.length) * 100,
        avg_score: totalScore / testCases.length,
      })
      .eq('id', evaluationRun.id);

    return NextResponse.json({
      success: true,
      data: {
        runId: evaluationRun.id,
        totalCases: testCases.length,
        correctCount,
        wrongCount,
        accuracy: (correctCount / testCases.length) * 100,
        avgScore: totalScore / testCases.length,
        results,
      },
    });
  } catch (error) {
    console.error('测试用例运行错误:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : '测试运行失败' },
      { status: 500 }
    );
  }
}
