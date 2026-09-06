import { isNotNull } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { securityAuditEvents } from '@/storage/database/shared/schema';
import { logger } from '@/lib/observability/logger';
import { observeSafetyAlert } from '@/lib/observability/metrics';
import { verifyAuditChainPartition } from './verification';

export interface AuditChainVerificationReport {
  readonly partitions: number;
  readonly checkedEvents: number;
  readonly invalidPartitions: readonly string[];
}

/**
 * 全量审计链校验：枚举所有分区并逐条验证哈希链。
 * 任何分区校验失败都会触发高优先级安全告警（AUDIT_CHAIN_BREAK）并记录错误，
 * 但不中断其余分区的校验。此前篡改检测依赖运维手工执行 CLI 脚本。
 */
export async function runAuditChainVerification(): Promise<AuditChainVerificationReport> {
  const partitions = (await db.selectDistinct({ partitionKey: securityAuditEvents.partitionKey })
    .from(securityAuditEvents)
    .where(isNotNull(securityAuditEvents.partitionKey)))
    .map((row) => row.partitionKey)
    .filter((key): key is string => Boolean(key));

  const invalidPartitions: string[] = [];
  let checkedEvents = 0;
  for (const partition of partitions) {
    try {
      const result = await verifyAuditChainPartition(partition);
      checkedEvents += result.checked;
    } catch (error) {
      invalidPartitions.push(partition);
      observeSafetyAlert('AUDIT_CHAIN_BREAK');
      logger.error('audit.chain.invalid', {
        partitionKey: partition,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('audit.chain.verified', {
    partitions: partitions.length,
    checkedEvents,
    invalid: invalidPartitions.length,
  });
  return { partitions: partitions.length, checkedEvents, invalidPartitions };
}
