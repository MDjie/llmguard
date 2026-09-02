import { processNextAudioVideoJob } from '../src/lib/media';

let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
const once = process.env.MEDIA_WORKER_ONCE === 'true';
const idleMs = Math.max(250, Number(process.env.MEDIA_WORKER_IDLE_MS ?? 2_000));

async function main() {
  do {
    const result = await processNextAudioVideoJob();
    if (result) console.log(JSON.stringify({ event: 'media.processed', ...result }));
    else if (!once && !stopping) await new Promise((resolve) => setTimeout(resolve, idleMs));
  } while (!once && !stopping);
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'media.worker.failed', type: error?.constructor?.name ?? 'unknown' }));
  process.exitCode = 1;
});
