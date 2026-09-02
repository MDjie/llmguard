/**
 * 裁判模型服务
 * 负责调用LLM进行语义检测（两阶段裁判 + RAG动态示例）
 */

import { db } from '@/lib/db';
import { llmProviders, judgeModelInvocations } from '@/storage/database/shared/schema';
import { and, eq } from 'drizzle-orm';
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
} from './engine';
import { callProviderChat } from '@/lib/providers';
import { logger } from '@/lib/observability/logger';
import { z } from 'zod';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';

const judgeConfigSchema = z.object({
  id: z.string().min(1),
  policyId: z.string().min(1),
  enabled: z.boolean(),
  providerId: z.string().min(1).optional(),
  mode: z.enum(['conservative', 'balanced', 'review_only']),
  triggerMode: z.enum(['risk_only', 'risk_or_semantic', 'always']),
  triggerThreshold: z.number().int().min(0).max(100),
  judgeThreshold: z.number().int().min(0).max(100),
  weight: z.number().min(0).max(1),
  applyToInput: z.boolean(),
  applyToOutput: z.boolean(),
  enabledDimensions: z.array(z.string().min(1).max(64)).max(100),
  semanticDimensions: z.array(z.string().min(1).max(64)).max(100),
  timeoutMs: z.number().int().min(100).max(60_000),
  fallbackAction: z.enum(['rule', 'allow', 'block']),
  failClosedForHighRisk: z.boolean(),
  maxTextLength: z.number().int().min(1).max(32_768),
  maskPiiBeforeJudge: z.boolean(),
  blockExternalForSecrets: z.boolean(),
});

export interface JudgeChatProvider {
  name: string;
  chat: (request: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<{ content: string; latencyMs: number }>;
  defaultModel: string;
  isPrivate: boolean;
  disabled: boolean;
}

export interface JudgeServiceDependencies {
  loadProvider?: (providerId: string) => Promise<JudgeChatProvider | null>;
  recordInvocation?: typeof recordInvocation;
}

/**
 * 获取Provider的聊天功能
 */
async function getProviderChat(
  providerId: string,
  scope: TenantScope,
): Promise<JudgeChatProvider | null> {
  try {
    const allProviders = await db
      .select()
      .from(llmProviders)
      .where(and(eq(llmProviders.id, providerId), scopePredicate(llmProviders, scope)))
      .limit(1);

    if (allProviders.length === 0) return null;

    if (!allProviders[0].isEnabled) {
      return {
        name: allProviders[0].displayName,
        chat: async () => {
          throw new Error('Provider is disabled');
        },
        defaultModel: allProviders[0].defaultModel || '',
        isPrivate: allProviders[0].providerType === 'ollama',
        disabled: true,
      };
    }

    const provider = allProviders[0];

    const isPrivate = provider.providerType === 'ollama';

    const chat = async (request: {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    }) => {
      return callProviderChat(
        provider,
        request.messages.map((message) => ({
          role:
            message.role === 'system' || message.role === 'assistant' ? message.role : 'user',
          content: message.content,
        })),
        {
          model: request.model || provider.defaultModel || undefined,
          temperature: request.temperature ?? 0.1,
          maxTokens: request.maxTokens ?? 1_024,
          timeoutMs: request.timeoutMs,
          signal: request.signal,
        },
      );
    };

    return {
      name: provider.name,
      chat,
      defaultModel: provider.defaultModel || '',
      isPrivate: isPrivate ?? false,
      disabled: false,
    };
  } catch {
    console.error('获取 Provider 失败');
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
  scope: TenantScope,
  sessionId?: string,
  signal?: AbortSignal,
  dependencies: JudgeServiceDependencies = {},
): Promise<JudgeModelResult> {
  const startTime = Date.now();

  if (!config.providerId) {
    return { used: false, error: 'JUDGE_PROVIDER_NOT_CONFIGURED' };
  }

  const provider = await (
    dependencies.loadProvider ?? ((providerId) => getProviderChat(providerId, scope))
  )(config.providerId);
  if (!provider) {
    return { used: false, error: 'JUDGE_PROVIDER_UNAVAILABLE' };
  }

  if (provider.disabled) {
    return { used: false, error: 'JUDGE_PROVIDER_DISABLED' };
  }

  // 准备发送给裁判模型的文本
  const { processedText, blockedExternal } = prepareTextForJudge(
    text, ruleFindings, config, provider.isPrivate
  );
  if (blockedExternal) {
    return { used: false, error: 'JUDGE_EXTERNAL_SECRET_BLOCKED', fallbackUsed: true };
  }
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  const deadlineSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

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
      timeoutMs: config.timeoutMs,
      signal: deadlineSignal,
    });

    const stage1HasRisk = parseStage1Response(stage1Response.content);
    if (stage1HasRisk === null) {
      return {
        used: true,
        error: 'JUDGE_STAGE1_RESPONSE_INVALID',
        parseError: 'JUDGE_STAGE1_RESPONSE_INVALID',
        fallbackUsed: true,
        latencyMs: Date.now() - startTime,
      };
    }

    // 规则引擎有命中 + 第一阶段判no → 仍然走第二阶段做二次确认
    // 纯粹靠规则引擎触发的case，裁判应该独立给出自己的意见
    const hasRisk = stage1HasRisk || ruleFindings.length > 0 || ruleScore > 0;

    if (!hasRisk) {
      const latencyMs = Date.now() - startTime;
      return {
        used: true,
        hasRisk: false,
        score: 0,
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
      timeoutMs: config.timeoutMs,
      signal: deadlineSignal,
    });

    const parsed = parseJudgeResponse(stage2Response.content);

    if (!parsed) {
      // JSON解析失败，但第一阶段已确认有风险，返回默认中风险
      const latencyMs = Date.now() - startTime;
      await (dependencies.recordInvocation ?? recordInvocation)({
        scope,
        sessionId, policyId: config.policyId, providerId: config.providerId,
        direction, modelName: provider.defaultModel,
        textLength: text.length, ruleScore,
        ruleAction: getActionFromScore(ruleScore, config.judgeThreshold),
        ruleFindings,
        parseError: 'JUDGE_STAGE2_RESPONSE_INVALID',
        latencyMs,
      });

      return {
        used: true,
        error: 'JUDGE_STAGE2_RESPONSE_INVALID',
        parseError: 'JUDGE_STAGE2_RESPONSE_INVALID',
        latencyMs,
        fallbackUsed: true,
      };
    }

    const latencyMs = Date.now() - startTime;

    await (dependencies.recordInvocation ?? recordInvocation)({
      scope,
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
    const errorCode =
      deadlineSignal.aborted || (error instanceof Error && error.name === 'AbortError')
        ? 'JUDGE_TIMEOUT'
        : 'JUDGE_CALL_FAILED';
    await (dependencies.recordInvocation ?? recordInvocation)({
      scope,
      sessionId, policyId: config.policyId, providerId: config.providerId,
      direction, modelName: provider.defaultModel,
      textLength: text.length, ruleScore,
      ruleAction: getActionFromScore(ruleScore, config.judgeThreshold),
      ruleFindings,
      errorMessage: errorCode,
      latencyMs: Date.now() - startTime,
    });

    return {
      used: true,
      error: errorCode,
      latencyMs: Date.now() - startTime,
      fallbackUsed: true,
    };
  }
}

function getActionFromScore(score: number, threshold: number): 'allow' | 'warn' | 'block' {
  if (score >= 80) return 'block';
  if (score >= threshold) return 'warn';
  return 'allow';
}

async function recordInvocation(params: {
  scope: TenantScope;
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
  parseError?: string;
  errorMessage?: string;
  latencyMs: number;
}): Promise<string> {
  try {
    const [inserted] = await db
      .insert(judgeModelInvocations)
      .values({
        tenantId: params.scope.tenantId,
        applicationId: params.scope.applicationId,
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
        rawResponse: undefined,
        parseError: params.parseError,
        errorMessage: params.errorMessage,
        latencyMs: params.latencyMs,
        usedInDecision: false,
      })
      .returning({ id: judgeModelInvocations.id });

    return inserted.id;
  } catch (error) {
    logger.error('judge.invocation.record.failed', { error });
    return '';
  }
}

export async function getJudgeConfig(
  policyId: string,
  scope: TenantScope,
): Promise<PolicyJudgeConfig | null> {
  try {
    const { policyJudgeConfigs } = await import('@/storage/database/shared/schema');

    const configs = await db
      .select()
      .from(policyJudgeConfigs)
      .where(and(
        eq(policyJudgeConfigs.policyId, policyId),
        scopePredicate(policyJudgeConfigs, scope),
      ))
      .limit(1);

    if (configs.length === 0) return null;

    const config = configs[0];
    return judgeConfigSchema.parse({
      id: config.id,
      policyId: config.policyId,
      enabled: config.enabled,
      providerId: config.providerId || undefined,
      mode: config.mode,
      triggerMode: config.triggerMode,
      triggerThreshold: config.triggerThreshold,
      judgeThreshold: config.judgeThreshold,
      weight: parseFloat(config.weight || '0.5'),
      applyToInput: config.applyToInput,
      applyToOutput: config.applyToOutput,
      enabledDimensions: (Array.isArray(config.enabledDimensions) ? config.enabledDimensions : []) as string[],
      semanticDimensions: (Array.isArray(config.semanticDimensions) ? config.semanticDimensions : []) as string[],
      timeoutMs: config.timeoutMs,
      fallbackAction: config.fallbackAction,
      failClosedForHighRisk: config.failClosedForHighRisk,
      maxTextLength: config.maxTextLength,
      maskPiiBeforeJudge: config.maskPiiBeforeJudge,
      blockExternalForSecrets: config.blockExternalForSecrets,
    });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === '42P01'
    ) {
      return null;
    }
    throw error;
  }
}
