import { verifyNextArtifact } from '../src/lib/artifacts';

let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
const once = process.env.ARTIFACT_WORKER_ONCE === 'true';
const idleMs = Math.max(250, Number(process.env.ARTIFACT_WORKER_IDLE_MS ?? 2_000));

async function main() {
  do {
    const result = await verifyNextArtifact();
    if (result) console.log(JSON.stringify({ event: 'artifact.verified', ...result }));
    else if (!once && !stopping) await new Promise((resolve) => setTimeout(resolve, idleMs));
  } while (!once && !stopping);
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'artifact.worker.failed', type: error?.constructor?.name ?? 'unknown' }));
  process.exitCode = 1;
});
