import { randomBytes, randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import type { RequestContext } from './types';

const TRACEPARENT_PATTERN = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}(?:-[\x20-\x7e]+)?$/i;

function traceIdFrom(request: NextRequest): string {
  const traceparent = request.headers.get('traceparent');
  const match = traceparent?.match(TRACEPARENT_PATTERN);
  const candidate = match?.[1]?.toLowerCase();

  if (candidate && candidate !== '00000000000000000000000000000000') {
    return candidate;
  }

  return randomBytes(16).toString('hex');
}

function clientIpFrom(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const candidate = request.headers.get('x-real-ip')?.trim() || forwarded || 'unknown';
  return candidate.slice(0, 64);
}

export function createRequestContext(
  request: NextRequest,
  now: () => number,
): RequestContext {
  return {
    requestId: randomUUID(),
    traceId: traceIdFrom(request),
    startedAt: now(),
    method: request.method.toUpperCase(),
    path: request.nextUrl.pathname,
    clientIp: clientIpFrom(request),
    ...(request.headers.get('user-agent')
      ? { userAgent: request.headers.get('user-agent')?.slice(0, 256) }
      : {}),
  };
}
