import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());
async function main() {
  const [{ reconcileExpiredGatewayRequests }, { closeDatabaseConnection }, { reconcileToolExecutions }] = await Promise.all([
    import('../src/lib/gateway-runtime/events'), import('../src/storage/database/shared/db'), import('../src/lib/tools/execution'),
  ]);
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; }); process.once('SIGTERM', () => { stopping = true; });
  try {
    do {
      const { announceGatewayPublication } = await import('../src/lib/gateway-runtime/publication');
      for (let i = 0; i < 20; i++) { const published = await announceGatewayPublication().catch(() => { console.error('GATEWAY_PUBLICATION_ANNOUNCEMENT_PENDING'); return null; }); if (!published) break; }
      const { anchorGatewayAuditBatch } = await import('../src/lib/gateway-runtime/audit-batches');
      for (let batch = 0; batch < 20; batch++) {
        const anchored = await anchorGatewayAuditBatch().catch(() => { console.error('GATEWAY_AUDIT_ANCHOR_RETRY_PENDING'); return null; });
        if (!anchored) break;
      }
      await reconcileExpiredGatewayRequests().catch(() => { console.error('GATEWAY_RECONCILIATION_RETRY_PENDING'); });
      const { projectSecurityAlerts } = await import('../src/lib/security-alerts/service');
      const projection = await projectSecurityAlerts().catch(() => { console.error('SECURITY_ALERT_PROJECTION_RETRY_PENDING'); return null; });
      if (projection?.quarantined) console.error('SECURITY_ALERT_PROJECTION_FAILED_RECORDS=' + projection.quarantined);
      const { purgeGatewayContent } = await import('../src/lib/gateway-runtime/content-retention');
      await purgeGatewayContent().catch(() => { console.error('GATEWAY_CONTENT_PURGE_RETRY_PENDING'); });
      await reconcileToolExecutions().catch(() => { console.error('TOOL_EXECUTION_RECONCILIATION_RETRY_PENDING'); });
      if (process.argv.includes('--once')) break;
      for (let i = 0; i < 10 && !stopping; i++) await new Promise(resolve => setTimeout(resolve,1000));
    } while (!stopping);
  } finally { await closeDatabaseConnection(); }
}
main().catch(() => { console.error('GATEWAY_RECONCILIATION_WORKER_FAILED'); process.exitCode = 1; });
