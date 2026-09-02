import { z } from 'zod';
import { withApiSecurity } from '@/lib/api-security';

const responseSchema = z.object({
  status: z.literal('healthy'),
  timestamp: z.string(),
  service: z.literal('guardllm'),
});

export const GET = withApiSecurity(
  {
    public: true,
    responseSchema,
    maxBodyBytes: 0,
    auditEvent: 'health.summary',
    auditFailureMode: 'open',
    rateLimitPolicy: {
      id: 'health-summary',
      windowMs: 60_000,
      maxRequests: 120,
      scope: 'ip',
    },
  },
  async () =>
    Response.json({
      status: 'healthy' as const,
      timestamp: new Date().toISOString(),
      service: 'guardllm' as const,
    }),
);
