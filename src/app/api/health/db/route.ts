import { z } from 'zod';
import { ApiProblem, withApiSecurity } from '@/lib/api-security';
import { db, sql } from '@/lib/db';

const responseSchema = z.object({
  status: z.literal('ready'),
  timestamp: z.string(),
});

export const GET = withApiSecurity(
  {
    public: true,
    responseSchema,
    maxBodyBytes: 0,
    auditEvent: 'health.readiness',
    auditFailureMode: 'open',
    skipAudit: true,
    rateLimitPolicy: {
      id: 'health-readiness',
      windowMs: 60_000,
      maxRequests: 120,
      scope: 'ip',
    },
  },
  async () => {
    try {
      await db.execute(sql`SELECT 1`);
    } catch {
      throw new ApiProblem({
        status: 503,
        code: 'DATABASE_NOT_READY',
        title: 'Service unavailable',
        detail: 'A required service dependency is not ready.',
      });
    }

    return Response.json({
      status: 'ready' as const,
      timestamp: new Date().toISOString(),
    });
  },
);
