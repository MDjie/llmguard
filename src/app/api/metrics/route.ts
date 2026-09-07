import { createApiSecurity } from '@/lib/api-security';
import { authenticateMetricsScrape } from '@/lib/observability/metrics-auth';
import { renderPrometheusMetrics } from '@/lib/observability/metrics';
import { collectGuardJobMetrics } from '@/lib/observability/job-metrics';
import { collectGatewayRuntimeMetrics } from '@/lib/observability/gateway-runtime-metrics';
import { collectGatewayCacheMetrics } from '@/lib/observability/gateway-cache-metrics';

const withApiSecurity = createApiSecurity({ authenticator: authenticateMetricsScrape }).withApiSecurity;

export const GET = withApiSecurity(
  {
    permission: 'observability:metrics:read',
    allowedResponseMediaTypes: ['text/plain'],
    maxBodyBytes: 0,
    auditEvent: 'observability.metrics.scrape',
    auditFailureMode: 'open',
    rateLimitPolicy: { id: 'metrics-scrape', windowMs: 60_000, maxRequests: 120, scope: 'ip' },
  },
  async () => {
    await Promise.all([collectGuardJobMetrics(), collectGatewayRuntimeMetrics()]);
    collectGatewayCacheMetrics();
    return new Response(renderPrometheusMetrics(), {
      headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
    });
  },
);
