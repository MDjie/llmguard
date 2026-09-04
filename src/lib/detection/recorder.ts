/**
 * 检测会话记录客户端
 * 通过 API 调用记录检测结果
 */

// 检测动作类型
export type DetectionAction = 'allow' | 'block' | 'warn' | 'mask' | 'rewrite';

// 处理动作类型
export type ProcessingAction = 'none' | 'mask' | 'rewrite';

// 白名单命中信息
export interface WhitelistMatchedForRecord {
  id: string;
  name: string;
  policyScope: string;
  dimensionScope: string;
  dimensionCodes: string[];
  pattern: string;
  matchType: string;
  effect: string;
}

// 被跳过的维度信息
export interface SkippedDimensionForRecord {
  dimensionCode: string;
  dimensionName: string;
  whitelistId: string;
  whitelistName: string;
  effect: string;
}

// 风险发现
export interface FindingForRecord {
  dimension: string;
  dimensionName?: string;
  score: number;
  confidence?: number;
  severity?: string;
  matchedRules?: string[];
  evidence?: string[];
  reason?: string;
  suggestion?: string;
  action?: string;
}

// 检测结果
export interface DetectionResultForRecord {
  action: DetectionAction;
  processingAction?: ProcessingAction;
  overallScore: number;
  confidence?: number;
  findings: FindingForRecord[];
  summary?: string;
  safeText?: string;
  maskedText?: string;
  rewrittenText?: string;
  latencyMs?: number;
  whitelistMatched?: WhitelistMatchedForRecord;
  skippedDimensions?: SkippedDimensionForRecord[];
}

// 记录会话的参数
export interface RecordSessionParams {
  // 用户输入
  userPrompt: string;
  // 模型原始输出（可选）
  mockModelOutput?: string;
  // 最终响应（脱敏/改写后）
  finalResponse?: string;
  // 输入检测结果
  inputDetection?: DetectionResultForRecord;
  // 输出检测结果
  outputDetection?: DetectionResultForRecord;
  // 策略ID
  policyId?: string;
  // 目标模型供应商ID
  targetProviderId?: string;
  // 评判模型供应商ID
  judgeProviderId?: string;
  // 用户ID
  userId?: string;
}

// 记录结果
export interface RecordSessionResult {
  success: boolean;
  sessionId?: string;
  error?: string;
}

/**
 * 记录检测会话（通过 API 调用）
 */
export async function recordDetectionSession(
  params: RecordSessionParams
): Promise<RecordSessionResult> {
  try {
    const response = await fetch('/api/detection-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const data = await response.json();

    if (data.success) {
      return {
        success: true,
        sessionId: data.data?.sessionId,
      };
    } else {
      return {
        success: false,
        error: data.error || '记录失败',
      };
    }
  } catch (error) {
    console.error('记录检测会话失败:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : '记录失败',
    };
  }
}

/**
 * 批量记录检测会话（用于策略回归验证等场景）
 */
export async function recordBatchDetectionSessions(
  sessions: RecordSessionParams[]
): Promise<{ success: number; failed: number; errors: string[] }> {
  const results = await Promise.all(
    sessions.map(session => recordDetectionSession(session))
  );

  const success = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const errors = results
    .filter(r => !r.success && r.error)
    .map(r => r.error!);

  return { success, failed, errors };
}
