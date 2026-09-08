import { withWorkerHeartbeat } from '../src/lib/operations/worker-health';
import { processNextEvaluationRun } from '../src/lib/evaluation';

let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });

const idleDelayMs = Math.max(250, Number(process.env.EVALUATION_WORKER_IDLE_MS ?? 2_000));
const runOnce = process.env.EVALUATION_WORKER_ONCE === 'true';

async function main(): Promise<void> {
  do {
    const result = await processNextEvaluationRun();
    if (result) {
      console.log(JSON.stringify({ event: 'evaluation.processed', ...result }));
    } else if (!runOnce && !stopping) {
      await new Promise((resolve) => setTimeout(resolve, idleDelayMs));
    }
  } while (!runOnce && !stopping);
}

withWorkerHeartbeat('evaluation', main).catch((error) => {
  console.error(JSON.stringify({
    event: 'evaluation.worker.failed',
    message: error instanceof Error ? error.message : 'unknown',
  }));
  process.exitCode = 1;
});
