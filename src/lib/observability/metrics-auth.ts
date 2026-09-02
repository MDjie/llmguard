import { timingSafeEqual } from 'node:crypto';
import type { ApiAuthenticator } from '@/lib/api-security';

function equal(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export const authenticateMetricsScrape: ApiAuthenticator = async (request) => {
  const configured = process.env.METRICS_BEARER_TOKEN;
  const header = request.headers.get('authorization');
  if (!configured || Buffer.byteLength(configured) < 32 || !header?.startsWith('Bearer ')) return null;
  if (!equal(header.slice(7), configured)) return null;
  return {
    subject: 'service:prometheus',
    roles: ['SYSTEM_ADMIN'],
    permissions: ['observability:metrics:read'],
    authenticationMethod: 'service',
  };
};
