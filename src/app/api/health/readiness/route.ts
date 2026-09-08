import { withApiSecurity } from '@/lib/api-security';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { inspectWorkerHealth } from '@/lib/operations/worker-health';
import { readMediaCapabilities } from '@/lib/media/capabilities';
export const GET = withApiSecurity({ permission: 'policy:read', responseSchema: jsonObjectResponseSchema, maxBodyBytes: 0, auditEvent: 'health.business-readiness', skipAudit: true, rateLimitPolicy: { id: 'business-readiness', windowMs: 60000, maxRequests: 30, scope: 'principal' } }, async () => {
  const [workers, media] = await Promise.all([inspectWorkerHealth(), readMediaCapabilities()]);
  return Response.json({ success: true, live: true, engineeringReady: workers.every(worker => worker.status === 'healthy') && !media.unavailableReason, productionQualified: false, qualificationReason: 'VERIFY_APPLICATION_POLICY_AND_EACH_MODEL_PROFILE', workers, media });
});
