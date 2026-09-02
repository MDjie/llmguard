/**
 * 文档检测引擎
 * 复用现有检测引擎进行文档内容检测
 * 支持精确定位证据位置
 */

import { db } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import {
  documentScanTasks,
  documentScanFindings,
} from '@/lib/db';
import { detectWithDynamicRules, clearPolicyCache } from '@/lib/detection/dynamic-engine';
import type { DetectionResult, SkippedDimension, WhitelistMatched } from '@/lib/detection/types';
import type { DocumentChunk, PlainLine } from './parser';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';

export interface DocumentDetectionOptions {
  taskId: string;
  chunks: DocumentChunk[];
  policyId: string;
  fileName: string;
  plainLines?: PlainLine[]; // 用于精确定位
  scope: TenantScope;
}

export interface DocumentDetectionResult {
  taskId: string;
  overallScore: number;
  finalAction: 'allow' | 'warn' | 'block';
  findings: DocumentFinding[];
  whitelistMatched?: WhitelistMatched;
  skippedDimensions?: SkippedDimension[];
}

export interface DocumentFinding {
  id: string;
  taskId: string;
  chunkIndex: number;
  lineNumber: number | null;
  startOffset: number | null;
  endOffset: number | null;
  locationStatus: 'located' | 'not_found';
  dimensionId?: string;
  dimensionCode: string;
  dimensionName: string;
  ruleId?: string;
  ruleName?: string;
  ruleType?: string;
  score: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  action: 'allow' | 'warn' | 'block' | 'mask' | 'rewrite';
  evidence: string[];
  maskedEvidence: string[];
  reason: string;
  suggestion: string;
  whitelistMatched?: WhitelistMatched;
  skippedDimensions?: SkippedDimension[];
}

/**
 * 在文本中定位证据并计算行号
 */
function locateEvidence(
  evidence: string,
  chunk: DocumentChunk,
  plainLines: PlainLine[]
): {
  lineNumber: number | null;
  startOffset: number | null;
  endOffset: number | null;
  locationStatus: 'located' | 'not_found';
} {
  if (!evidence || evidence.trim().length === 0) {
    return {
      lineNumber: null,
      startOffset: null,
      endOffset: null,
      locationStatus: 'not_found',
    };
  }

  // 在 chunk 内容中查找证据
  const localIndex = chunk.content.indexOf(evidence);

  if (localIndex < 0) {
    // 证据未在 chunk 中找到
    return {
      lineNumber: null,
      startOffset: null,
      endOffset: null,
      locationStatus: 'not_found',
    };
  }

  // 计算全局偏移量
  const startOffset = chunk.startOffset + localIndex;
  const endOffset = startOffset + evidence.length;

  // 查找对应的行号
  const line = plainLines.find(
    l => startOffset >= l.startOffset && startOffset <= l.endOffset
  );

  return {
    lineNumber: line?.lineNumber ?? null,
    startOffset,
    endOffset,
    locationStatus: line ? 'located' : 'not_found',
  };
}

/**
 * 对文档分片进行检测
 */
export async function detectDocument(
  options: DocumentDetectionOptions
): Promise<DocumentDetectionResult> {
  const { taskId, chunks, policyId, fileName, plainLines = [], scope } = options;

  const allFindings: DocumentFinding[] = [];
  let maxScore = 0;
  let finalAction: 'allow' | 'warn' | 'block' = 'allow';
  let globalWhitelistMatched: WhitelistMatched | undefined;
  const allSkippedDimensions: SkippedDimension[] = [];

  // 更新任务状态
  await db.update(documentScanTasks)
    .set({
      status: 'detecting',
      statusMessage: `正在检测 ${chunks.length} 个文本片段...`,
      updatedAt: new Date(),
    })
    .where(and(eq(documentScanTasks.id, taskId), scopePredicate(documentScanTasks, scope)));

  // 对每个分片进行检测
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    try {
      // 调用现有检测引擎
      const result: DetectionResult = await detectWithDynamicRules(
        chunk.content,
        policyId,
        scope,
        'input' // 文档检测使用 input 方向
      );

      // 处理检测结果
      if (result.findings && result.findings.length > 0) {
        for (const finding of result.findings) {
          // 定位证据
          let lineNumber: number | null = null;
          let startOffset: number | null = null;
          let endOffset: number | null = null;
          let locationStatus: 'located' | 'not_found' = 'not_found';

          // 尝试使用证据定位
          if (finding.evidence && finding.evidence.length > 0) {
            // 优先使用原始证据（非脱敏）进行定位
            const originalEvidence = finding.evidence[0];
            const location = locateEvidence(originalEvidence, chunk, plainLines);
            lineNumber = location.lineNumber;
            startOffset = location.startOffset;
            endOffset = location.endOffset;
            locationStatus = location.locationStatus;
          }

          // 如果无法定位，使用 chunk 的起始行作为备用
          if (!lineNumber) {
            lineNumber = null; // 不使用默认值 1
            startOffset = null;
            endOffset = null;
            locationStatus = 'not_found';
          }

          const docFinding: DocumentFinding = {
            id: crypto.randomUUID(),
            taskId,
            chunkIndex: i,
            lineNumber,
            startOffset,
            endOffset,
            locationStatus,
            dimensionId: finding.dimensionId,
            dimensionCode: finding.dimensionCode || finding.dimension || 'unknown',
            dimensionName: finding.dimensionName || '未知维度',
            ruleId: finding.ruleId,
            ruleName: finding.ruleName,
            ruleType: finding.ruleType,
            score: finding.score,
            severity: getSeverity(finding.score),
            action: mapAction(finding.action),
            evidence: finding.evidence || [],
            maskedEvidence: finding.maskedEvidence || [],
            reason: finding.reason || '',
            suggestion: finding.suggestion || '',
            whitelistMatched: finding.whitelistMatched,
            skippedDimensions: finding.skippedDimensions,
          };

          allFindings.push(docFinding);

          // 更新最高分数
          if (finding.score > maxScore) {
            maxScore = finding.score;
          }
        }
      }

      // 记录全局白名单命中
      if (result.whitelistMatched && !globalWhitelistMatched) {
        globalWhitelistMatched = result.whitelistMatched;
      }

      // 收集跳过的维度
      if (result.skippedDimensions && result.skippedDimensions.length > 0) {
        for (const skipped of result.skippedDimensions) {
          if (!allSkippedDimensions.find(s => s.dimensionCode === skipped.dimensionCode)) {
            allSkippedDimensions.push(skipped);
          }
        }
      }

      // 更新最终动作
      if (result.action === 'block') {
        finalAction = 'block';
      } else if (result.action === 'warn' && finalAction !== 'block') {
        finalAction = 'warn';
      }

    } catch (error) {
      console.error(`分片 ${i} 检测失败:`, error);
    }
  }

  // 保存检测结果到数据库
  await saveFindings(taskId, allFindings, scope);

  // 更新任务状态
  await db.update(documentScanTasks)
    .set({
      status: 'completed',
      statusMessage: '检测完成',
      overallScore: maxScore,
      finalAction,
      findingsCount: allFindings.length,
      whitelistMatched: globalWhitelistMatched,
      skippedDimensions: allSkippedDimensions,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(documentScanTasks.id, taskId), scopePredicate(documentScanTasks, scope)));

  return {
    taskId,
    overallScore: maxScore,
    finalAction,
    findings: allFindings,
    whitelistMatched: globalWhitelistMatched,
    skippedDimensions: allSkippedDimensions,
  };
}

/**
 * 将检测结果保存到数据库
 */
async function saveFindings(
  taskId: string,
  findings: DocumentFinding[],
  scope: TenantScope,
): Promise<void> {
  if (findings.length === 0) return;

  const values = findings.map(f => ({
    tenantId: scope.tenantId,
    applicationId: scope.applicationId,
    id: f.id,
    taskId: f.taskId,
    chunkIndex: f.chunkIndex,
    lineNumber: f.lineNumber,
    startOffset: f.startOffset,
    endOffset: f.endOffset,
    locationStatus: f.locationStatus,
    dimensionId: f.dimensionId,
    dimensionCode: f.dimensionCode,
    dimensionName: f.dimensionName,
    ruleId: f.ruleId,
    ruleName: f.ruleName,
    ruleType: f.ruleType,
    score: f.score,
    severity: f.severity,
    action: f.action,
    evidence: f.evidence,
    maskedEvidence: f.maskedEvidence,
    reason: f.reason,
    suggestion: f.suggestion,
    whitelistMatched: f.whitelistMatched,
    skippedDimensions: f.skippedDimensions,
    status: 'open' as const,
  }));

  await db.insert(documentScanFindings).values(values);
}

/**
 * 根据分数确定严重程度
 */
function getSeverity(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score >= 90) return 'critical';
  if (score >= 70) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}

/**
 * 映射动作类型
 */
function mapAction(action: string | undefined): 'allow' | 'warn' | 'block' | 'mask' | 'rewrite' {
  switch (action) {
    case 'block':
      return 'block';
    case 'warn':
      return 'warn';
    case 'mask':
      return 'mask';
    case 'rewrite':
      return 'rewrite';
    default:
      return 'allow';
  }
}

// 导出 clearPolicyCache 供外部使用
export { clearPolicyCache };
