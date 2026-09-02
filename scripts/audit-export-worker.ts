import { dispatchNextAuditExport } from '../src/lib/audit';
import { logger } from '../src/lib/observability/logger';

const parsedPollMs = Number(process.env.AUDIT_EXPORT_POLL_MS ?? '1000');
if (!Number.isSafeInteger(parsedPollMs) || parsedPollMs < 100 || parsedPollMs > 60_000) {
  throw new Error('AUDIT_EXPORT_POLL_MS must be between 100 and 60000');
}

async function main(): Promise<void> {
  for (;;) {
    const result = await dispatchNextAuditExport();
    if (result) logger.info('audit.export.processed', result);
    else await new Promise((resolve) => setTimeout(resolve, parsedPollMs));
  }
}

main().catch((error: unknown) => {
  logger.error('audit.export.worker_failed', { error });
  process.exitCode = 1;
});
