import { processNextSecurityScan } from '../src/lib/security-scanning';

let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });

const idleDelayMs = Math.max(250, Number(process.env.SECURITY_SCAN_WORKER_IDLE_MS ?? 2_000));
const runOnce = process.env.SECURITY_SCAN_WORKER_ONCE === 'true';

async function main(): Promise<void> {
  do {
    const result = await processNextSecurityScan();
    if (result) {
      console.log(JSON.stringify({ event: 'security-scan.processed', ...result }));
    } else if (!runOnce && !stopping) {
      await new Promise((resolve) => setTimeout(resolve, idleDelayMs));
    }
  } while (!runOnce && !stopping);
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: 'security-scan.worker.failed',
    message: error instanceof Error ? error.message : 'unknown',
  }));
  process.exitCode = 1;
});
