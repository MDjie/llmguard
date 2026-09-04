import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { getDefaultPolicyId } from '@/lib/detection/dynamic-engine';
import { detectWithGuardEngineV2 } from '@/lib/detection/v2-compat';
import { DetectionPolicyError } from '@/lib/detection/errors';
import { requireTenantContext } from '@/lib/tenancy';
import { experimentalLabsEnabled } from '@/lib/product-features';

const bodySchema = z
  .object({
    text: z.string().min(1).max(32_768),
    policyId: z.string().min(1).max(36).optional(),
    direction: z.enum(['input', 'output']).default('input'),
  })
  .strict();

const responseSchema = z.object({
  success: z.literal(true),
  data: z.record(z.string(), z.unknown()),
});

export const POST = withApiSecurity(
  {
    permission: 'guard:use',
    bodySchema,
    responseSchema,
    maxBodyBytes: 256 * 1_024,
    auditEvent: 'guard.simulate',
    rateLimitPolicy: {
      id: 'guard-simulate',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  async ({ body, request, principal }) => {
    if (!experimentalLabsEnabled()) {
      throw new ApiProblem({
        status: 404,
        code: 'EXPERIMENTAL_FEATURE_DISABLED',
        title: 'Not found',
        detail: 'The legacy simulation API is disabled.',
      });
    }

    try {
      const { text, policyId, direction } = body;
      const scope = requireTenantContext(principal);
      const targetPolicyId = policyId ?? (await getDefaultPolicyId(scope));

      if (!targetPolicyId) {
        throw new DetectionPolicyError(
          'POLICY_NOT_AVAILABLE',
          'No default detection policy is active',
        );
      }

      const steps: Array<{
        step: number;
        name: string;
        status: string;
        content: unknown;
        duration: number;
      }> = [];
      const totalStartTime = Date.now();

      steps.push({
        step: 1,
        name: '用户输入',
        status: 'completed',
        content: text,
        duration: 0,
      });

      const inputStartTime = Date.now();
      const inputDetection = await detectWithGuardEngineV2(
        text,
        targetPolicyId,
        scope,
        direction,
        { signal: request.signal, allowPreRelease: true },
      );
      steps.push({
        step: 2,
        name: '输入护栏检测',
        status: 'completed',
        content: detectionSummary(inputDetection),
        duration: Date.now() - inputStartTime,
      });

      if (inputDetection.action === 'block') {
        steps.push({
          step: 3,
          name: 'Target LLM生成',
          status: 'skipped',
          content: '输入已拦截，跳过模型调用',
          duration: 0,
        });
        steps.push({
          step: 4,
          name: '输出护栏检测',
          status: 'skipped',
          content: null,
          duration: 0,
        });
        steps.push({
          step: 5,
          name: '最终响应',
          status: 'completed',
          content: `[已拦截] ${inputDetection.summary || '检测到风险内容'}`,
          duration: Date.now() - totalStartTime,
        });

        return Response.json({
          success: true as const,
          data: {
            sessionId: null,
            steps,
            summary: {
              inputAction: inputDetection.action,
              inputScore: inputDetection.overallScore,
              outputAction: null,
              outputScore: null,
              finalAction: 'block',
              totalTime: Date.now() - totalStartTime,
            },
          },
        });
      }

      steps.push({
        step: 3,
        name: 'Target LLM生成',
        status: 'completed',
        content: '[模拟响应] 这是一个模拟的AI响应内容。',
        duration: 50,
      });

      const outputStartTime = Date.now();
      const outputDetection = await detectWithGuardEngineV2(
        '[模拟响应] 这是一个模拟的AI响应内容。',
        targetPolicyId,
        scope,
        'output',
        { signal: request.signal, allowPreRelease: true },
      );
      steps.push({
        step: 4,
        name: '输出护栏检测',
        status: 'completed',
        content: detectionSummary(outputDetection),
        duration: Date.now() - outputStartTime,
      });

      const finalAction =
        outputDetection.action === 'block' ? 'block' : inputDetection.action;
      steps.push({
        step: 5,
        name: '最终响应',
        status: 'completed',
        content: `[${
          finalAction === 'allow' ? '放行' : finalAction === 'warn' ? '警告' : '拦截'
        }] 检测完成`,
        duration: Date.now() - totalStartTime,
      });

      return Response.json({
        success: true as const,
        data: {
          sessionId: null,
          steps,
          summary: {
            inputAction: inputDetection.action,
            inputScore: inputDetection.overallScore,
            outputAction: outputDetection.action,
            outputScore: outputDetection.overallScore,
            finalAction,
            totalTime: Date.now() - totalStartTime,
          },
        },
      });
    } catch (error) {
      if (error instanceof DetectionPolicyError) {
        throw unavailablePolicy(error);
      }
      throw error;
    }
  },
);

function detectionSummary(
  result: Awaited<ReturnType<typeof detectWithGuardEngineV2>>,
): Record<string, unknown> {
  return {
    action: result.action,
    score: result.overallScore,
    confidence: result.confidence,
    findings: result.findings.map((finding) => ({
      dimension: finding.dimension,
      dimensionName: finding.dimensionName,
      score: finding.score,
      matchedRules: finding.matchedRules,
      evidence: finding.evidence,
    })),
  };
}

function unavailablePolicy(error: DetectionPolicyError): ApiProblem {
  return new ApiProblem({
    status: 503,
    code: error.code,
    title: '检测策略不可用',
    detail: '当前没有可安全执行的检测策略，请联系安全管理员。',
  });
}
