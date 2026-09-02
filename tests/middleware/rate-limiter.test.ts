import { NextRequest, NextResponse } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  composeMiddleware,
  createRateLimiter,
  withRateLimit,
} from '../../src/lib/middleware/rate-limiter';

function request(path: string, ip = '203.0.113.10'): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: { 'x-forwarded-for': ip },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('legacy rate limiter middleware', () => {
  it('allows requests up to the limit and then returns retry headers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'));
    const next = vi.fn(async () => NextResponse.json({ ok: true }));
    const limiter = createRateLimiter({ windowMs: 2_000, maxRequests: 1 });
    const req = request('/limited/first');

    const allowed = await limiter(req, next);
    const blocked = await limiter(req, next);

    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('x-ratelimit-limit')).toBe('1');
    expect(allowed.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('x-ratelimit-reset')).toBe('2');
    expect(next).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_001);
    expect((await limiter(req, next)).status).toBe(200);
  });

  it('can count only failed responses and use a custom rejection response', async () => {
    const key = `skip-success-${Date.now()}`;
    const handler = vi.fn(() => NextResponse.json({ rejected: true }, { status: 503 }));
    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      skipSuccessfulRequests: true,
      keyGenerator: () => key,
      handler,
    });
    const req = request('/limited/skip-success');

    expect((await limiter(req, async () => NextResponse.json({ ok: true }))).status).toBe(200);
    expect((await limiter(req, async () => NextResponse.json({ ok: false }, { status: 500 }))).status).toBe(500);
    expect((await limiter(req, async () => NextResponse.json({ ok: true }))).status).toBe(503);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('composes middleware in order and wraps route handlers', async () => {
    const calls: string[] = [];
    const first = async (_request: NextRequest, next: () => Promise<NextResponse>) => {
      calls.push('first:before');
      const response = await next();
      calls.push('first:after');
      return response;
    };
    const second = async (_request: NextRequest, next: () => Promise<NextResponse>) => {
      calls.push('second:before');
      const response = await next();
      calls.push('second:after');
      return response;
    };

    expect((await composeMiddleware(first, second)(request('/composed'))).status).toBe(200);
    expect(calls).toEqual(['first:before', 'second:before', 'second:after', 'first:after']);

    const limiter = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 2,
      keyGenerator: () => `wrapped-${Date.now()}`,
    });
    const wrapped = withRateLimit(
      async () => NextResponse.json({ connected: true }),
      limiter,
    );
    await expect((await wrapped(request('/wrapped'))).json()).resolves.toEqual({ connected: true });
  });
});
