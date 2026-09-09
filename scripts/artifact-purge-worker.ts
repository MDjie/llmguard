import { closeDatabaseConnection } from '../src/storage/database/shared/db';
import { enqueueExpiredArtifacts, purgeNextArtifact } from '../src/lib/artifacts/purge';
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
async function main() {
  do {
    const queued = await enqueueExpiredArtifacts();
    const result = await purgeNextArtifact();
    console.log(JSON.stringify({ event: 'artifact.purge', queued, result }));
    if (!stopping && process.env.ARTIFACT_PURGE_ONCE !== 'true') await new Promise(resolve => setTimeout(resolve, 5000));
  } while (!stopping && process.env.ARTIFACT_PURGE_ONCE !== 'true');
}
main().catch(() => { console.error('ARTIFACT_PURGE_WORKER_FAILED'); process.exitCode = 1; }).finally(closeDatabaseConnection);
