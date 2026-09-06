import { z } from 'zod';
import { withApiSecurity } from '@/lib/api-security';

const liveResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('guardllm'),
  timestamp: z.iso.datetime(),
});

export const GET = withApiSecurity(
  {
    public: true,
    responseSchema: liveResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'health.live.read',
    auditFailureMode: 'open',
    skipAudit: true,
    rateLimitPolicy: {
      id: 'health-live',
      windowMs: 60_000,
      maxRequests: 120,
      scope: 'ip',
    },
  },
  async () =>
    Response.json({
      status: 'ok' as const,
      service: 'guardllm' as const,
      timestamp: new Date().toISOString(),
    }),
);
