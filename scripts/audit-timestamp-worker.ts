import { logger } from '../src/lib/observability/logger';
import { timestampPendingAuditEvents } from '../src/lib/audit/timestamp-worker';

let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });

const once = process.env.AUDIT_TIMESTAMP_WORKER_ONCE === 'true';
const idleMs = Math.max(1_000, Number(process.env.AUDIT_TIMESTAMP_WORKER_IDLE_MS ?? 60_000));
const batchSize = Math.max(1, Number(process.env.AUDIT_TIMESTAMP_BATCH_SIZE ?? 20));

async function main(): Promise<void> {
  do {
    const anchored = await timestampPendingAuditEvents(batchSize);
    if (anchored > 0) logger.info('audit.timestamp.batch.completed', { anchored });
    else if (!once && !stopping) {
      await new Promise((resolve) => setTimeout(resolve, idleMs));
    }
  } while (!once && !stopping);
}

main().catch((error) => {
  logger.error('audit.timestamp.worker.failed', { error });
  process.exitCode = 1;
});
