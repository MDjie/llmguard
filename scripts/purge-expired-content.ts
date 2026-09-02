import { logger } from '../src/lib/observability/logger';
import { purgeExpiredContent } from '../src/lib/data-protection/retention';

async function main(): Promise<void> {
  const batchSize = Number(process.env.CONTENT_PURGE_BATCH_SIZE ?? 500);
  const result = await purgeExpiredContent(new Date(), batchSize);
  logger.info('content.retention.purge.completed', result);
}

main().catch((error) => {
  logger.error('content.retention.purge.failed', { error });
  process.exitCode = 1;
});
