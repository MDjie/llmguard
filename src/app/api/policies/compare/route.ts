import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { detectWithGuardEngineV2 } from '@/lib/detection/v2-compat';
import { DetectionPolicyError } from '@/lib/detection/errors';
import { requireTenantContext } from '@/lib/tenancy';

const bodySchema = z
  .object({
    policyAId: z.string().min(1).max(36),
    policyBId: z.string().min(1).max(36),
    text: z.string().min(1).max(32_768),
    direction: z.enum(['input', 'output']).default('input'),
  })
  .strict()
  .refine(({ policyAId, policyBId }) => policyAId !== policyBId, {
    message: 'Policies must be different',
    path: ['policyBId'],
  });

const responseSchema = z.object({
  success: z.literal(true),
  resultA: z.record(z.string(), z.unknown()),
  resultB: z.record(z.string(), z.unknown()),
  diff: z.record(z.string(), z.unknown()),
});

export const POST = withApiSecurity(
  {
    permission: 'policy:read',
    bodySchema,
    responseSchema,
    maxBodyBytes: 256 * 1_024,
    auditEvent: 'policy.compare',
    rateLimitPolicy: {
      id: 'policy-compare',
      windowMs: 60_000,
      maxRequests: 30,
      scope: 'principal',
    },
  },
  async ({ body, request, principal }) => {
    try {
      const { policyAId, policyBId, text, direction } = body;
      const scope = requireTenantContext(principal);
      const [resultA, resultB] = await Promise.all([
        detectWithGuardEngineV2(text, policyAId, scope, direction, {
          signal: request.signal,
          allowPreRelease: true,
        }),
        detectWithGuardEngineV2(text, policyBId, scope, direction, {
          signal: request.signal,
          allowPreRelease: true,
        }),
      ]);

      const processedResultA = buildProcessedResult(text, resultA);
      const processedResultB = buildProcessedResult(text, resultB);
      const scoreDiff = Math.abs(resultA.overallScore - resultB.overallScore);
      const actionDiff = getActionDiff(resultA.action, resultB.action);
      const strategyASeverity = getStrategySeverity(resultA.overallScore, resultA.action);
      const strategyBSeverity = getStrategySeverity(resultB.overallScore, resultB.action);
      const conclusion = generateConclusion(resultA, resultB, scoreDiff);

      return Response.json({
        success: true as const,
        resultA: processedResultA,
        resultB: processedResultB,
        diff: {
          scoreDiff,
          actionDiff,
          strategyASeverity,
          strategyBSeverity,
          conclusion,
        },
      });
    } catch (error) {
      if (error instanceof DetectionPolicyError) {
        throw new ApiProblem({
          status: 503,
          code: error.code,
          title: '检测策略不可用',
          detail: '至少一个待比较策略不存在或当前不可安全执行。',
        });
      }
      throw error;
    }
  },
);

function buildProcessedResult(text: string, result: Awaited<ReturnType<typeof detectWithGuardEngineV2>>) {
  const baseResult = {
    action: result.action,
    overallScore: result.overallScore,
    findings: result.findings.map(f => ({
      dimension: f.dimension,
      dimensionName: f.dimensionName,
      score: f.score,
      evidence: f.evidence,
      action: f.action,
    })),
    summary: result.summary,
    latencyMs: result.latencyMs,
    processedText: text,
  };

  if (result.action === 'mask') {
    let maskedText = result.maskedText ?? text;
    for (const finding of result.findings) {
      if (finding.evidence && finding.evidence.length > 0) {
        for (const evidence of finding.evidence) {
          if (evidence && evidence.length > 2) {
            const maskedEvidence = evidence[0] + '*'.repeat(Math.min(evidence.length - 2, 8)) + evidence[evidence.length - 1];
            maskedText = maskedText.split(evidence).join(maskedEvidence);
          }
        }
      }
    }
    return { ...baseResult, processedText: maskedText, maskedText };
  }

  if (result.action === 'rewrite') {
    let rewrittenText = result.rewrittenText ?? text;
    for (const finding of result.findings) {
      if (finding.dimension === 'pii_leak' && finding.evidence) {
        for (const evidence of finding.evidence) {
          if (evidence && evidence.length > 2) {
            rewrittenText = rewrittenText.replace(
              new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
              '[个人信息已保护]'
            );
          }
        }
      }
    }
    return { ...baseResult, processedText: rewrittenText, rewrittenText };
  }

  return baseResult;
}

function getActionDiff(actionA: string, actionB: string): string {
  if (actionA === actionB) {
    return '两个策略处理动作相同';
  }

  const actionOrder = ['allow', 'warn', 'mask', 'rewrite', 'block'];
  const indexA = actionOrder.indexOf(actionA);
  const indexB = actionOrder.indexOf(actionB);

  if (indexA < indexB) {
    return `策略B 更严格 (${getActionLabel(actionA)} → ${getActionLabel(actionB)})`;
  } else {
    return `策略A 更严格 (${getActionLabel(actionB)} → ${getActionLabel(actionA)})`;
  }
}

function getActionLabel(action: string): string {
  const labels: Record<string, string> = {
    allow: '放行',
    warn: '警告',
    mask: '脱敏',
    rewrite: '改写',
    block: '拦截',
  };
  return labels[action] || action;
}

function getStrategySeverity(score: number, action: string): 'loose' | 'moderate' | 'strict' {
  if (action === 'block' || score >= 80) {
    return 'strict';
  }
  if (action === 'warn' || action === 'mask' || action === 'rewrite' || score >= 50) {
    return 'moderate';
  }
  return 'loose';
}

function generateConclusion(
  resultA: { action: string; overallScore: number },
  resultB: { action: string; overallScore: number },
  scoreDiff: number,
): string {
  if (resultA.action === resultB.action && resultA.overallScore === resultB.overallScore) {
    return '两个策略对该内容的处理结果完全一致';
  }

  const severityOrder = ['loose', 'moderate', 'strict'];
  const severityA = getStrategySeverity(resultA.overallScore, resultA.action);
  const severityB = getStrategySeverity(resultB.overallScore, resultB.action);
  
  const indexA = severityOrder.indexOf(severityA);
  const indexB = severityOrder.indexOf(severityB);

  if (indexB > indexA) {
    if (resultB.action === 'block') {
      return `策略B 更严格，会拦截该内容，适合对安全性要求较高的场景`;
    }
    return `策略B 对该内容更敏感，适合需要较高安全级别的场景`;
  } else if (indexA > indexB) {
    if (resultA.action === 'block') {
      return `策略A 更严格，会拦截该内容，适合对安全性要求较高的场景`;
    }
    return `策略A 对该内容更敏感，适合需要较高安全级别的场景`;
  }

  if (scoreDiff <= 10) {
    return `两个策略差异较小，可根据其他因素选择`;
  }

  return `两个策略存在明显差异，建议根据实际安全需求选择`;
}
