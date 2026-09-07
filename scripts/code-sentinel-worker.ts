import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());
async function main() {
  const [{ processNextCodeScanJob }, { closeDatabaseConnection }] = await Promise.all([import('../src/lib/connectors/code-sentinel'), import('../src/storage/database/shared/db')]);
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; }); process.once('SIGTERM', () => { stopping = true; });
  try { do { await processNextCodeScanJob().catch(() => console.error('CODE_SENTINEL_WORKER_CHECK_FAILED')); if (process.argv.includes('--once')) break; for (let n = 0; n < 5 && !stopping; n++) await new Promise(resolve => setTimeout(resolve,1000)); } while (!stopping); }
  finally { await closeDatabaseConnection(); }
}
main().catch(() => { console.error('CODE_SENTINEL_WORKER_FAILED'); process.exitCode = 1; });
