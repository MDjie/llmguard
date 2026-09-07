import { enqueueDecisionRecord } from '@/lib/security-alerts/service';
import { fromLegacySession } from '@/lib/security-alerts/record';
import type { z } from 'zod';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { recordDetectionSessionSchema } from '@/contracts/http/history';
import { withApiSecurity } from '@/lib/api-security';
import { db } from '@/lib/db';
import { detectionSessions, detectionRecords, riskFindings } from '@/lib/db';
import {
  contentFingerprint,
  mayPersistRawContent,
} from '@/lib/data-protection/content';
import { buildIncidentPersistenceRecords } from '@/lib/incidents/service';
import { canonicalJson } from '@/lib/policy-bundle';
import { requireTenantContext } from '@/lib/tenancy';
import {
  incidentTransitions,
  securityIncidents,
} from '@/storage/database/shared/schema';

// 检测动作类型
type DetectionAction = 'allow' | 'block' | 'warn' | 'mask' | 'rewrite';
type RecordSessionParams = z.infer<typeof recordDetectionSessionSchema>;

/**
 * 确定最终动作（取最严格的）
 */
function determineFinalAction(
  inputAction?: DetectionAction,
  outputAction?: DetectionAction
): DetectionAction {
  const priority: DetectionAction[] = ['block', 'rewrite', 'mask', 'warn', 'allow'];
  const inputPriority = inputAction ? priority.indexOf(inputAction) : 4;
  const outputPriority = outputAction ? priority.indexOf(outputAction) : 4;
  return priority[Math.min(inputPriority, outputPriority)];
}

/**
 * 生成 UUID
 */
function generateUUID(): string {
  return crypto.randomUUID();
}

export function automaticIncidentSlaMinutes(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = Number(environment.INCIDENT_AUTO_CREATE_SLA_MINUTES ?? '60');
  if (!Number.isInteger(value) || value < 5 || value > 90 * 24 * 60) {
    throw new Error('INCIDENT_AUTO_CREATE_SLA_MINUTES must be an integer between 5 and 129600');
  }
  return value;
}

function automaticIncidentInput(
  params: RecordSessionParams,
  sessionId: string,
) {
  const findings = [
    ...(params.inputDetection?.findings ?? []),
    ...(params.outputDetection?.findings ?? []),
  ];
  const primary = findings.toSorted((left, right) => (right.score ?? 0) - (left.score ?? 0))[0];
  const maximumScore = Math.max(
    params.inputDetection?.overallScore ?? 0,
    params.outputDetection?.overallScore ?? 0,
    ...findings.map((finding) => finding.score ?? 0),
  );
  const declaredSeverity = primary?.severity?.toUpperCase();
  const severity = declaredSeverity === 'CRITICAL' || maximumScore >= 90
    ? 'CRITICAL'
    : declaredSeverity === 'HIGH' || maximumScore >= 75
      ? 'HIGH'
      : 'MEDIUM';
  const riskType = primary?.dimension ?? 'guard_block';
  return {
    title: 'Blocked model interaction: ' + riskType,
    severity,
    sessionId,
    riskType,
    eventAnalysis: canonicalJson({
      decision: 'BLOCK',
      inputAction: params.inputDetection?.action,
      inputScore: params.inputDetection?.overallScore,
      outputAction: params.outputDetection?.action,
      outputScore: params.outputDetection?.overallScore,
      maximumScore,
    }),
    attackTechnique: canonicalJson({
      dimensions: [...new Set(findings.map((finding) => finding.dimension))],
      matchedRules: [...new Set(findings.flatMap((finding) => finding.matchedRules ?? []))],
    }),
    impact: 'The unsafe interaction was blocked and queued for security review.',
    answerEvidence: canonicalJson({
      sessionId,
      inputHash: contentFingerprint(params.userPrompt),
      outputHash: params.mockModelOutput
        ? contentFingerprint(params.mockModelOutput)
        : params.finalResponse
          ? contentFingerprint(params.finalResponse)
          : null,
      findingCount: findings.length,
    }),
    slaMinutes: automaticIncidentSlaMinutes(),
  } as const;
}

/**
 * POST /api/detection-sessions
 * 记录检测会话
 */
async function recordDetectionSession(
  params: RecordSessionParams,
  principal: NonNullable<Parameters<typeof mayPersistRawContent>[0]>,
): Promise<Response> {
    const sessionId = generateUUID();
    const scope = requireTenantContext(principal);
    const persistRawContent = mayPersistRawContent(principal);
    const whitelistMatched =
      params.inputDetection?.whitelistMatched ?? params.outputDetection?.whitelistMatched;
    const skippedDimensions =
      params.inputDetection?.skippedDimensions ?? params.outputDetection?.skippedDimensions;

    // 计算总耗时
    const totalDurationMs = 
      (params.inputDetection?.latencyMs || 0) + 
      (params.outputDetection?.latencyMs || 0);

    // 确定最终动作
    const finalAction = determineFinalAction(
      params.inputDetection?.action,
      params.outputDetection?.action
    );

    await db.transaction(async (transaction) => {
    // 1. 写入检测会话
    await transaction.insert(detectionSessions).values({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      id: sessionId,
      userId: principal.subject,
      userPrompt: persistRawContent ? params.userPrompt : null,
      userPromptHash: contentFingerprint(params.userPrompt),
      mockModelOutput: persistRawContent ? params.mockModelOutput || null : null,
      mockModelOutputHash: params.mockModelOutput
        ? contentFingerprint(params.mockModelOutput)
        : null,
      finalResponse: persistRawContent ? params.finalResponse || null : null,
      finalResponseHash: params.finalResponse ? contentFingerprint(params.finalResponse) : null,
      inputAction: params.inputDetection?.action || null,
      inputScore: params.inputDetection?.overallScore?.toString() || null,
      inputSummary: persistRawContent ? params.inputDetection?.summary || null : null,
      outputAction: params.outputDetection?.action || null,
      outputScore: params.outputDetection?.overallScore?.toString() || null,
      outputSummary: persistRawContent ? params.outputDetection?.summary || null : null,
      finalAction: finalAction,
      policyId: params.policyId || null,
      targetProviderId: params.targetProviderId || null,
      judgeProviderId: params.judgeProviderId || null,
      durationMs: totalDurationMs || null,
      // 保存白名单命中信息
      whitelistMatched:
        whitelistMatched as typeof detectionSessions.$inferInsert.whitelistMatched,
      skippedDimensions:
        skippedDimensions as typeof detectionSessions.$inferInsert.skippedDimensions,
    });

    // 2. 写入输入检测记录（如果有）
    if (params.inputDetection) {
      const recordId = generateUUID();
      await transaction.insert(detectionRecords).values({
        tenantId: scope.tenantId,
        applicationId: scope.applicationId,
        id: recordId,
        sessionId,
        direction: 'input',
        rawText: persistRawContent ? params.userPrompt : null,
        rawTextHash: contentFingerprint(params.userPrompt),
        maskedText: null,
        rewrittenText: null,
        overallScore: params.inputDetection.overallScore?.toString() || null,
        confidence: params.inputDetection.confidence?.toString() || null,
        action: params.inputDetection.action || null,
        processingAction: null,
        summary: persistRawContent ? params.inputDetection.summary || null : null,
        ruleLatencyMs: params.inputDetection.latencyMs || null,
        cozeLatencyMs: null,
        totalLatencyMs: params.inputDetection.latencyMs || null,
      });

      // 写入风险发现
      if (params.inputDetection.findings && params.inputDetection.findings.length > 0) {
        for (const finding of params.inputDetection.findings) {
          await transaction.insert(riskFindings).values({
            tenantId: scope.tenantId,
            applicationId: scope.applicationId,
            id: generateUUID(),
            recordId,
            dimension: finding.dimension,
            score: finding.score?.toString() || null,
            confidence: null,
            severity: finding.severity || null,
            matchedRules: finding.matchedRules || null,
            evidence: persistRawContent ? finding.evidence || null : null,
            reason: persistRawContent ? finding.reason || null : null,
            suggestion: null,
          });
        }
      }
    }

    // 3. 写入输出检测记录（如果有）
    if (params.outputDetection && (params.mockModelOutput || params.finalResponse)) {
      const recordId = generateUUID();
      await transaction.insert(detectionRecords).values({
        tenantId: scope.tenantId,
        applicationId: scope.applicationId,
        id: recordId,
        sessionId,
        direction: 'output',
        rawText: persistRawContent
          ? params.mockModelOutput || params.finalResponse || null
          : null,
        rawTextHash: contentFingerprint(
          params.mockModelOutput || params.finalResponse || '',
        ),
        maskedText: null,
        rewrittenText: null,
        overallScore: params.outputDetection.overallScore?.toString() || null,
        confidence: params.outputDetection.confidence?.toString() || null,
        action: params.outputDetection.action || null,
        processingAction: null,
        summary: persistRawContent ? params.outputDetection.summary || null : null,
        ruleLatencyMs: params.outputDetection.latencyMs || null,
        cozeLatencyMs: null,
        totalLatencyMs: params.outputDetection.latencyMs || null,
      });

      // 写入风险发现
      if (params.outputDetection.findings && params.outputDetection.findings.length > 0) {
        for (const finding of params.outputDetection.findings) {
          await transaction.insert(riskFindings).values({
            tenantId: scope.tenantId,
            applicationId: scope.applicationId,
            id: generateUUID(),
            recordId,
            dimension: finding.dimension,
            score: finding.score?.toString() || null,
            confidence: null,
            severity: finding.severity || null,
            matchedRules: finding.matchedRules || null,
            evidence: persistRawContent ? finding.evidence || null : null,
            reason: persistRawContent ? finding.reason || null : null,
            suggestion: null,
          });
        }
      }
    }

    for (const record of fromLegacySession(sessionId, params)) await enqueueDecisionRecord(transaction, scope, record);

    if (finalAction === 'block') {
      const records = buildIncidentPersistenceRecords(
        scope,
        automaticIncidentInput(params, sessionId),
      );
      await transaction.insert(securityIncidents).values(records.incident);
      await transaction.insert(incidentTransitions).values(records.transition);
    }
    });

    return Response.json({
      success: true,
      data: { sessionId },
    });
}

export const POST = withApiSecurity(
  {
    permission: 'guard:use',
    bodySchema: recordDetectionSessionSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 512 * 1_024,
    auditEvent: 'detection-session.record',
    rateLimitPolicy: {
      id: 'detection-session-record',
      windowMs: 60_000,
      maxRequests: 120,
      scope: 'principal',
    },
  },
  async ({ body, principal }) => {
    if (!principal) {
      throw new Error('Authenticated principal missing after authorization');
    }
    return recordDetectionSession(body, principal);
  },
);
