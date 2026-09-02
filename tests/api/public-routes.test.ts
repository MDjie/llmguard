import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { GET as getHealth } from '../../src/app/api/health/route';
import { GET as getLiveHealth } from '../../src/app/api/health/live/route';
import { GET as getMetrics } from '../../src/app/api/metrics/route';
import robots from '../../src/app/robots';
import { createRequestContext } from '../../src/lib/api-security/request-context';
import { authenticateMetricsScrape } from '../../src/lib/observability/metrics-auth';

const originalMetricsToken = process.env.METRICS_BEARER_TOKEN;

afterEach(() => {
  if (originalMetricsToken === undefined) delete process.env.METRICS_BEARER_TOKEN;
  else process.env.METRICS_BEARER_TOKEN = originalMetricsToken;
});

describe('public operational routes', () => {
  it.each([
    ['/api/health', getHealth, 'healthy'],
    ['/api/health/live', getLiveHealth, 'ok'],
  ] as const)('serves %s with validated correlation metadata', async (path, handler, status) => {
    const response = await handler(new NextRequest(`http://localhost${path}`), {});
    const body = await response.json() as {
      service: string;
      status: string;
      timestamp: string;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toMatchObject({ service: 'guardllm', status });
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('publishes crawler exclusions for API and framework internals', () => {
    expect(robots()).toEqual({
      rules: {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/_next/', '/static/'],
      },
    });
  });
});

describe('metrics authentication boundary', () => {
  it('rejects anonymous and weakly configured scrape requests', async () => {
    delete process.env.METRICS_BEARER_TOKEN;
    const anonymous = await getMetrics(new NextRequest('http://localhost/api/metrics'), {});
    expect(anonymous.status).toBe(401);

    process.env.METRICS_BEARER_TOKEN = 'too-short';
    const weakRequest = new NextRequest('http://localhost/api/metrics', {
      headers: { authorization: 'Bearer too-short' },
    });
    const weak = await authenticateMetricsScrape(
      weakRequest,
      createRequestContext(weakRequest, () => 0),
    );
    expect(weak).toBeNull();
  });

  it('uses constant-length bearer verification and returns a service principal', async () => {
    const token = 'metrics-token-that-is-at-least-32-bytes-long';
    process.env.METRICS_BEARER_TOKEN = token;

    const wrongRequest = new NextRequest('http://localhost/api/metrics', {
      headers: { authorization: 'Bearer wrong-token-with-a-different-length' },
    });
    const wrong = await authenticateMetricsScrape(
      wrongRequest,
      createRequestContext(wrongRequest, () => 0),
    );
    const validRequest = new NextRequest('http://localhost/api/metrics', {
      headers: { authorization: `Bearer ${token}` },
    });
    const principal = await authenticateMetricsScrape(
      validRequest,
      createRequestContext(validRequest, () => 0),
    );

    expect(wrong).toBeNull();
    expect(principal).toEqual({
      subject: 'service:prometheus',
      roles: ['SYSTEM_ADMIN'],
      permissions: ['observability:metrics:read'],
      authenticationMethod: 'service',
    });
  });
});
