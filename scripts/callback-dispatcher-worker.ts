import { dispatchNextJobCallback } from '../src/lib/guard-jobs';

let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
const once = process.env.CALLBACK_WORKER_ONCE === 'true';
const idleMs = Math.max(250, Number(process.env.CALLBACK_WORKER_IDLE_MS ?? 2_000));

async function main() {
  do {
    const result = await dispatchNextJobCallback();
    if (result) console.log(JSON.stringify({ event: 'callback.delivery', ...result }));
    else if (!once && !stopping) await new Promise((resolve) => setTimeout(resolve, idleMs));
  } while (!once && !stopping);
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'callback.worker.failed', type: error?.constructor?.name ?? 'unknown' }));
  process.exitCode = 1;
});
