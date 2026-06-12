/**
 * 裁判模型服务
 * 负责调用LLM进行语义检测（两阶段裁判 + RAG动态示例）
 */

import { db } from '@/lib/db';
import { llmProviders, judgeModelInvocations } from '@/storage/database/shared/schema';
import { eq, and } from 'drizzle-orm';
import type { DetectionFinding } from '@/lib/detection/types';
import type {
  PolicyJudgeConfig,
  JudgeModelResult,
  LLMJudgeResponse,
} from './types';
import {
  buildJudgePrompt,
  parseStage1Response,
  parseJudgeResponse,
  prepareTextForJudge,
  generateTextHash,
} from './engine';

/**
 * 获取Provider的聊天功能
 */
async function getProviderChat(providerId: string): Promise<{
  name: string;
  chat: (request: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    maxTokens?: number;
  }) => Promise<{ content: string; latencyMs: number }>;
  defaultModel: string;
  isPrivate: boolean;
} | null> {
  try {
    const allProviders = await db
      .select()
      .from(llmProviders)
      .where(eq(llmProviders.id, providerId))
      .limit(1);

    if (allProviders.length === 0) return { _disabled: false } as any;

    if (!allProviders[0].isEnabled) {
      return { _disabled: true, _displayName: allProviders[0].displayName } as any;
    }

    const provider = allProviders[0];

    const isPrivate = provider.providerType === 'ollama' ||
                      provider.baseUrl?.includes('localhost') ||
                      provider.baseUrl?.includes('127.0.0.1') ||
                      provider.baseUrl?.includes('internal');

    const chat = async (request: {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
      maxTokens?: number;
    }) => {
      const startTime = Date.now();

      const baseUrl = provider.baseUrl || '';
      const apiKey = provider.apiKeyEncrypted;

      const isOllama = provider.providerType === 'ollama';
      const endpoint = isOllama
        ? `${baseUrl}/v1/chat/completions`
        : `${baseUrl}/chat/completions`;

      const requestBody = {
        model: request.model || provider.defaultModel,
        messages: request.messages,
        temperature: request.temperature ?? 0.1,
        max_tokens: request.maxTokens ?? 1024,
      };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`LLM API error: ${response.status}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || data.message?.content || '';

      return {
        content,
        latencyMs: Date.now() - startTime,
      };
    };

    return {
      name: provider.name,
      chat,
      defaultModel: provider.defaultModel || '',
      isPrivate: isPrivate ?? false,
    };
  } catch (error) {
    console.error('获取Provider失败:', error);
    return null;
  }
}

/**
 * 执行裁判模型检测（两阶段 + RAG）
 */
export async function executeJudgeDetection(
  text: string,
  direction: 'input' | 'output',
  ruleFindings: DetectionFinding[],
  ruleScore: number,
  config: PolicyJudgeConfig,
  sessionId?: string
): Promise<JudgeModelResult> {
  const startTime = Date.now();

  if (!config.providerId) {
    return { used: false, error: '未配置裁判模型Provider' };
  }

  const provider = await getProviderChat(config.providerId);
  if (!provider) {
    return { used: false, error: '裁判模型Provider不可用' };
  }

  if ((provider as any)._disabled) {
    const displayName = (provider as any)._displayName || '裁判模型';
    return { used: false, error: `${displayName}已关闭` };
  }

  // 准备发送给裁判模型的文本
  const { processedText, maskedItems, blockedExternal } = prepareTextForJudge(
    text, ruleFindings, config, provider.isPrivate
  );

  // 推断可能的维度（用于RAG检索）
  const likelyDimension = ruleFindings.length > 0
    ? ruleFindings[0].dimension
    : inferDimensionFromText(text);

  try {
    // 构建所有prompt（第一阶段 + 第二阶段）
    const prompts = buildJudgePrompt(
      processedText, direction, ruleFindings, ruleScore
    );

    // ========== 第一阶段：二分类（始终执行，保持独立判断） ==========
    const stage1Response = await provider.chat({
      model: provider.defaultModel,
      messages: [
        { role: 'system', content: prompts.stage1System },
        { role: 'user', content: prompts.stage1User },
      ],
      temperature: 0.1,
      maxTokens: 32,
    });

    const stage1HasRisk = parseStage1Response(stage1Response.content);

    // 规则引擎有命中 + 第一阶段判no → 仍然走第二阶段做二次确认
    // 纯粹靠规则引擎触发的case，裁判应该独立给出自己的意见
    const hasRisk = stage1HasRisk || ruleFindings.length > 0 || ruleScore > 0;

    if (!hasRisk) {
      const latencyMs = Date.now() - startTime;
      return {
        used: true,
        hasRisk: false,
        score: 0,
        confidence: 0.8,
        suggestedAction: 'allow',
        reason: '两阶段裁判：第一阶段判定无风险',
        dimensionResults: [],
        latencyMs,
      };
    }

    // ========== 第二阶段：详细评分（有风险时才执行） ==========

    // RAG：检索相似案例作为few-shot（暂时禁用）
    const ragExamples = '';

    const detailedPrompts = buildJudgePrompt(
      processedText, direction, ruleFindings, ruleScore, ragExamples
    );

    const stage2Response = await provider.chat({
      model: provider.defaultModel,
      messages: [
        { role: 'system', content: detailedPrompts.stage2System },
        { role: 'user', content: detailedPrompts.stage2User },
      ],
      temperature: 0.1,
      maxTokens: 512,
    });

    const parsed = parseJudgeResponse(stage2Response.content);

    if (!parsed) {
      // JSON解析失败，但第一阶段已确认有风险，返回默认中风险
      const latencyMs = Date.now() - startTime;
      await recordInvocation({
        sessionId, policyId: config.policyId, providerId: config.providerId,
        direction, modelName: provider.defaultModel,
        textLength: text.length, ruleScore,
        ruleAction: getActionFromScore(ruleScore, config.judgeThreshold),
        ruleFindings,
        rawResponse: `阶段1:${stage1Response.content} | 阶段2:${stage2Response.content}`,
        parseError: '第二阶段JSON解析失败',
        latencyMs,
      });

      // 降级：第一阶段确认有风险，给一个保守的中风险评分
      return {
        used: true,
        hasRisk: true,
        score: 55,
        confidence: 0.5,
        suggestedAction: 'warn',
        reason: '裁判模型检测到风险（详细评分解析失败，使用降级评分）',
        dimensionResults: ruleFindings.map(f => ({
          dimensionCode: f.dimension,
          dimensionName: f.dimensionName,
          hasRisk: true,
          score: 55,
          confidence: 0.5,
          reason: f.reason,
        })),
        latencyMs,
        fallbackUsed: true,
      };
    }

    const latencyMs = Date.now() - startTime;

    await recordInvocation({
      sessionId, policyId: config.policyId, providerId: config.providerId,
      direction, modelName: provider.defaultModel,
      textLength: text.length, ruleScore,
      ruleAction: getActionFromScore(ruleScore, config.judgeThreshold),
      ruleFindings,
      judgeScore: parsed.score,
      judgeConfidence: parsed.confidence,
      judgeAction: parsed.suggestedAction,
      judgeReason: parsed.reason,
      judgeDimensions: parsed.dimensionResults,
      ruleReview: parsed.ruleReview,
      latencyMs,
    });

    return {
      used: true,
      hasRisk: parsed.hasRisk,
      score: parsed.score,
      confidence: parsed.confidence,
      suggestedAction: parsed.suggestedAction,
      reason: parsed.reason,
      dimensionResults: parsed.dimensionResults,
      ruleReview: parsed.ruleReview,
      latencyMs,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '未知错误';
    await recordInvocation({
      sessionId, policyId: config.policyId, providerId: config.providerId,
      direction, modelName: provider.defaultModel,
      textLength: text.length, ruleScore,
      ruleAction: getActionFromScore(ruleScore, config.judgeThreshold),
      ruleFindings,
      errorMessage,
      latencyMs: Date.now() - startTime,
    });

    return {
      used: true,
      error: errorMessage,
      latencyMs: Date.now() - startTime,
      fallbackUsed: true,
    };
  }
}

/**
 * 从文本推断可能的维度
 */
function inferDimensionFromText(text: string): string {
  const dimPatterns: Record<string, RegExp[]> = {
    prompt_injection: [/扮演/, /忽略.*指令/, /越狱/, /绕过.*限制/, /假装/],
    pii_leak: [/获取.*信息/, /了解.*行踪/, /监控/, /跟踪/, /聊天记录/],
    malicious_code: [/木马/, /病毒/, /后门/, /恶意.*代码/, /攻击.*工具/],
    violence_hate: [/暴力/, /仇恨/, /攻击/, /杀/, /伤害/],
    illegal_content: [/违法/, /赌博/, /毒品/, /黑产/, /洗钱/],
    fraud_scam: [/诈骗/, /钓鱼/, /欺诈/, /骗/],
  };

  for (const [dim, patterns] of Object.entries(dimPatterns)) {
    for (const p of patterns) {
      if (p.test(text)) return dim;
    }
  }
  return 'prompt_injection'; // 默认维度
}

function getActionFromScore(score: number, threshold: number): 'allow' | 'warn' | 'block' {
  if (score >= 80) return 'block';
  if (score >= threshold) return 'warn';
  return 'allow';
}

async function recordInvocation(params: {
  sessionId?: string;
  policyId: string;
  providerId: string;
  direction: 'input' | 'output';
  modelName: string;
  textLength: number;
  ruleScore: number;
  ruleAction: 'allow' | 'warn' | 'block';
  ruleFindings: DetectionFinding[];
  judgeScore?: number;
  judgeConfidence?: number;
  judgeAction?: 'allow' | 'warn' | 'block';
  judgeReason?: string;
  judgeDimensions?: LLMJudgeResponse['dimensionResults'];
  ruleReview?: LLMJudgeResponse['ruleReview'];
  rawResponse?: string;
  parseError?: string;
  errorMessage?: string;
  latencyMs: number;
}): Promise<string> {
  try {
    const [inserted] = await db
      .insert(judgeModelInvocations)
      .values({
        sessionId: params.sessionId,
        policyId: params.policyId,
        providerId: params.providerId,
        direction: params.direction,
        modelName: params.modelName,
        promptVersion: 'v2-two-stage-rag',
        textLength: params.textLength,
        ruleScore: params.ruleScore,
        ruleAction: params.ruleAction,
        ruleFindings: params.ruleFindings.map((f) => ({
          dimension: f.dimension,
          dimensionName: f.dimensionName,
          score: f.score,
          action: f.action,
          reason: f.reason,
        })),
        judgeScore: params.judgeScore,
        judgeConfidence: params.judgeConfidence?.toString(),
        judgeAction: params.judgeAction,
        judgeReason: params.judgeReason,
        judgeDimensions: params.judgeDimensions,
        ruleReview: params.ruleReview,
        rawResponse: params.rawResponse ? { content: params.rawResponse } : undefined,
        parseError: params.parseError,
        errorMessage: params.errorMessage,
        latencyMs: params.latencyMs,
        usedInDecision: false,
      })
      .returning({ id: judgeModelInvocations.id });

    return inserted.id;
  } catch (error) {
    console.error('记录裁判模型调用失败:', error);
    return '';
  }
}

export async function getJudgeConfig(policyId: string): Promise<PolicyJudgeConfig | null> {
  try {
    const { policyJudgeConfigs } = await import('@/storage/database/shared/schema');

    const configs = await db
      .select()
      .from(policyJudgeConfigs)
      .where(eq(policyJudgeConfigs.policyId, policyId))
      .limit(1);

    if (configs.length === 0) return null;

    const config = configs[0];
    return {
      id: config.id,
      policyId: config.policyId,
      enabled: config.enabled,
      providerId: config.providerId || undefined,
      mode: config.mode as 'conservative' | 'balanced' | 'review_only',
      triggerMode: config.triggerMode as 'risk_only' | 'risk_or_semantic' | 'always',
      triggerThreshold: config.triggerThreshold,
      judgeThreshold: config.judgeThreshold,
      weight: parseFloat(config.weight || '0.5'),
      applyToInput: config.applyToInput,
      applyToOutput: config.applyToOutput,
      enabledDimensions: (Array.isArray(config.enabledDimensions) ? config.enabledDimensions : []) as string[],
      semanticDimensions: (Array.isArray(config.semanticDimensions) ? config.semanticDimensions : []) as string[],
      timeoutMs: config.timeoutMs,
      fallbackAction: config.fallbackAction as 'rule' | 'allow' | 'block',
      failClosedForHighRisk: config.failClosedForHighRisk,
      maxTextLength: config.maxTextLength,
      maskPiiBeforeJudge: config.maskPiiBeforeJudge,
      blockExternalForSecrets: config.blockExternalForSecrets,
    };
  } catch (error) {
    console.error('获取裁判模型配置失败:', error);
    return null;
  }
}
