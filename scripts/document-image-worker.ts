import { processNextIntakeJob } from '../src/lib/media/intake-worker';
import { processNextDocumentImageJob } from '../src/lib/multimodal';

let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
const once = process.env.MULTIMODAL_WORKER_ONCE === 'true';
const idleMs = Math.max(250, Number(process.env.MULTIMODAL_WORKER_IDLE_MS ?? 2_000));

async function main() {
  let preferIntake = true;
  do {
    // Alternate queues so sustained uploads cannot starve legacy document jobs.
    const result = preferIntake
      ? await processNextIntakeJob() ?? await processNextDocumentImageJob()
      : await processNextDocumentImageJob() ?? await processNextIntakeJob();
    preferIntake = !preferIntake;
    if (result) console.log(JSON.stringify({ event: 'multimodal.document-image.processed', ...result }));
    else if (!once && !stopping) await new Promise((resolve) => setTimeout(resolve, idleMs));
  } while (!once && !stopping);
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'multimodal.worker.failed', type: error?.constructor?.name ?? 'unknown' }));
  process.exitCode = 1;
});
