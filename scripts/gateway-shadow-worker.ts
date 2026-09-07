import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());
async function main() {
  if (process.env.GATEWAY_SHADOW_EVALUATION_ENABLED !== 'true') throw new Error('SHADOW_WORKER_EXPLICIT_ENABLE_REQUIRED');
  const [{ runGatewayShadow }, { closeDatabaseConnection }] = await Promise.all([import('../src/lib/gateway-runtime/shadow'), import('../src/storage/database/shared/db')]);
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; }); process.once('SIGTERM', () => { stopping = true; });
  try {
    do {
      const result = await runGatewayShadow().catch(() => { console.error('GATEWAY_SHADOW_RECONCILIATION_PENDING'); return null; });
      if (process.argv.includes('--once')) break;
      if (!result) await new Promise(resolve => setTimeout(resolve, 1000));
    } while (!stopping);
  } finally { await closeDatabaseConnection(); }
}
main().catch(() => { console.error('GATEWAY_SHADOW_WORKER_FAILED'); process.exitCode = 1; });
