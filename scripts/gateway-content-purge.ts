import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());
async function main() {
  const [{ purgeGatewayContent }, { closeDatabaseConnection }] = await Promise.all([
    import('../src/lib/gateway-runtime/content-retention'), import('../src/storage/database/shared/db'),
  ]);
  try { console.log(JSON.stringify(await purgeGatewayContent(undefined, new Date(), Number(process.env.GATEWAY_CONTENT_PURGE_BATCH_SIZE ?? 100)))); }
  finally { await closeDatabaseConnection(); }
}
main().catch(() => { console.error('GATEWAY_CONTENT_PURGE_FAILED'); process.exitCode = 1; });
