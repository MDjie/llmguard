import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createApiSecurity,
  MemoryRateLimiter,
  withLegacyApiSecurity,
} from '../../src/lib/api-security';
import type { AuthenticatedPrincipal } from '../../src/lib/api-security';

const publicPolicy = {
  id: 'test-public',
  windowMs: 60_000,
  maxRequests: 20,
  scope: 'ip' as const,
};

const principal: AuthenticatedPrincipal = {
  subject: 'user-1',
  roles: ['SECURITY_ADMIN'],
  permissions: ['policy:read'],
  authenticationMethod: 'cookie',
  tenantId: 'tenant-1',
  applicationId: 'app-1',
};

function request(
  method = 'GET',
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): NextRequest {
  return new NextRequest('http://localhost/api/example', {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('withApiSecurity', () => {
  it('allows an explicitly public endpoint and emits correlation headers', async () => {
    const { withApiSecurity } = createApiSecurity();
    const handler = withApiSecurity(
      {
        public: true,
        maxBodyBytes: 0,
        auditEvent: 'test.public',
        rateLimitPolicy: publicPolicy,
      },
      async () => Response.json({ ok: true }),
    );

    const response = await handler(request(), undefined);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get('x-trace-id')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('denies an endpoint by default when no principal is authenticated', async () => {
    const { withApiSecurity } = createApiSecurity();
    const handler = withApiSecurity(
      {
        maxBodyBytes: 0,
        auditEvent: 'test.protected',
        rateLimitPolicy: publicPolicy,
      },
      async () => Response.json({ ok: true }),
    );

    const response = await handler(request(), undefined);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
      status: 401,
    });
  });

  it('authenticates protected endpoints before parsing their request body', async () => {
    const parseAttempt = vi.fn();
    const { withApiSecurity } = createApiSecurity();
    const handler = withApiSecurity(
      {
        bodySchema: z.object({
          secret: z.string().superRefine(() => parseAttempt()),
        }),
        maxBodyBytes: 128,
        auditEvent: 'test.auth-before-body',
        rateLimitPolicy: publicPolicy,
      },
      async () => Response.json({ ok: true }),
    );

    const response = await handler(request('POST', { secret: 'not-readable-anonymously' }), undefined);

    expect(response.status).toBe(401);
    expect(parseAttempt).not.toHaveBeenCalled();
  });

  it('rejects a principal without the required permission', async () => {
    const { withApiSecurity } = createApiSecurity({ authenticator: async () => principal });
    const handler = withApiSecurity(
      {
        permission: 'policy:manage',
        maxBodyBytes: 0,
        auditEvent: 'test.permission',
        rateLimitPolicy: publicPolicy,
      },
      async () => Response.json({ ok: true }),
    );

    const response = await handler(request(), undefined);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('validates JSON input before invoking the handler', async () => {
    const invoke = vi.fn(async () => Response.json({ ok: true }));
    const { withApiSecurity } = createApiSecurity();
    const handler = withApiSecurity(
      {
        public: true,
        bodySchema: z.object({ message: z.string().min(3) }),
        maxBodyBytes: 128,
        auditEvent: 'test.schema',
        rateLimitPolicy: publicPolicy,
      },
      invoke,
    );

    const response = await handler(request('POST', { message: 'x' }), undefined);

    expect(response.status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ code: 'BODY_VALIDATION_FAILED' });
  });

  it('rejects an oversized body even when Content-Length is absent', async () => {
    const { withApiSecurity } = createApiSecurity();
    const handler = withApiSecurity(
      {
        public: true,
        bodySchema: z.object({ message: z.string() }),
        maxBodyBytes: 10,
        auditEvent: 'test.body-limit',
        rateLimitPolicy: publicPolicy,
      },
      async () => Response.json({ ok: true }),
    );
    const oversized = request('POST', { message: 'this is too long' });
    oversized.headers.delete('content-length');

    const response = await handler(oversized, undefined);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: 'REQUEST_BODY_TOO_LARGE' });
  });

  it('requires a matching double-submit token for cookie-authenticated writes', async () => {
    const { withApiSecurity } = createApiSecurity({ authenticator: async () => principal });
    const handler = withApiSecurity(
      {
        permission: 'policy:read',
        maxBodyBytes: 0,
        auditEvent: 'test.csrf',
        rateLimitPolicy: publicPolicy,
      },
      async () => Response.json({ ok: true }),
    );

    const denied = await handler(
      request('POST', undefined, { cookie: 'csrf-token=expected' }),
      undefined,
    );
    const allowed = await handler(
      request('POST', undefined, {
        cookie: 'csrf-token=expected',
        'x-csrf-token': 'expected',
        origin: 'http://localhost',
      }),
      undefined,
    );

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
  });

  it('validates CSRF origin against the external Host used by a custom server', async () => {
    const { withApiSecurity } = createApiSecurity({ authenticator: async () => principal });
    const handler = withApiSecurity(
      {
        permission: 'policy:read',
        maxBodyBytes: 0,
        auditEvent: 'test.csrf-custom-host',
        rateLimitPolicy: publicPolicy,
      },
      async () => Response.json({ ok: true }),
    );
    const headers = {
      cookie: 'csrf-token=expected',
      'x-csrf-token': 'expected',
      host: 'localhost:3100',
    };

    const allowed = await handler(
      new NextRequest('http://0.0.0.0:3100/api/example', {
        method: 'POST',
        headers: { ...headers, origin: 'http://localhost:3100' },
      }),
      undefined,
    );
    const denied = await handler(
      new NextRequest('http://0.0.0.0:3100/api/example', {
        method: 'POST',
        headers: { ...headers, origin: 'http://attacker.example' },
      }),
      undefined,
    );

    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ code: 'CSRF_ORIGIN_REJECTED' });
  });

  it('returns 429 with retry metadata when the policy is exhausted', async () => {
    const limiter = new MemoryRateLimiter(() => 1_000);
    const { withApiSecurity } = createApiSecurity({ rateLimiter: limiter, now: () => 1_000 });
    const handler = withApiSecurity(
      {
        public: true,
        maxBodyBytes: 0,
        auditEvent: 'test.rate-limit',
        rateLimitPolicy: { ...publicPolicy, id: 'test-exhausted', maxRequests: 1 },
      },
      async () => Response.json({ ok: true }),
    );

    const first = await handler(request(), undefined);
    const second = await handler(request(), undefined);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('60');
    await expect(second.json()).resolves.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  });

  it('fails closed when response validation fails and does not expose details', async () => {
    const reportError = vi.fn();
    const { withApiSecurity } = createApiSecurity({ reportError });
    const handler = withApiSecurity(
      {
        public: true,
        responseSchema: z.object({ ok: z.literal(true) }),
        maxBodyBytes: 0,
        auditEvent: 'test.response-schema',
        rateLimitPolicy: publicPolicy,
      },
      async () => Response.json({ ok: false, secret: 'do-not-leak' }),
    );

    const response = await handler(request(), undefined);

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('do-not-leak');
    expect(reportError).not.toHaveBeenCalled();
  });

  it('validates dynamic route parameters before the handler runs', async () => {
    const called = vi.fn();
    const { withApiSecurity } = createApiSecurity();
    const handler = withApiSecurity(
      {
        public: true,
        paramsSchema: z.object({ id: z.string().uuid() }),
        maxBodyBytes: 0,
        auditEvent: 'test.params',
        rateLimitPolicy: publicPolicy,
      },
      async () => {
        called();
        return Response.json({ ok: true });
      },
    );

    const response = await handler(request(), {
      params: Promise.resolve({ id: '../invalid' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'ROUTE_PARAMS_VALIDATION_FAILED',
    });
    expect(called).not.toHaveBeenCalled();
  });

  it('allows only explicitly declared non-JSON response media types', async () => {
    const { withApiSecurity } = createApiSecurity();
    const handler = withApiSecurity(
      {
        public: true,
        responseSchema: z.object({ ok: z.literal(true) }),
        allowedResponseMediaTypes: ['text/csv'],
        maxBodyBytes: 0,
        auditEvent: 'test.csv',
        rateLimitPolicy: publicPolicy,
      },
      async () =>
        new Response('name\nvalue', {
          headers: { 'content-type': 'text/csv; charset=utf-8' },
        }),
    );

    const response = await handler(request(), undefined);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
  });

  it('rejects request media types outside an endpoint allowlist', async () => {
    const { withApiSecurity } = createApiSecurity();
    const handler = withApiSecurity(
      {
        public: true,
        allowedRequestMediaTypes: ['multipart/form-data'],
        maxBodyBytes: 1_024,
        auditEvent: 'test.multipart',
        rateLimitPolicy: publicPolicy,
      },
      async () => Response.json({ ok: true }),
    );

    const response = await handler(request('POST', { file: 'not multipart' }), undefined);
    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
  });
});

describe('withLegacyApiSecurity', () => {
  it('validates a cloned JSON body while preserving the original for the legacy handler', async () => {
    const handler = withLegacyApiSecurity(
      {
        public: true,
        bodySchema: z.object({ name: z.string().min(1) }).strict(),
        responseSchema: z.object({ name: z.string() }),
        maxBodyBytes: 1_024,
        auditEvent: 'legacy.test',
        rateLimitPolicy: publicPolicy,
      },
      async (legacyRequest) => {
        const body = (await legacyRequest.json()) as { name: string };
        return Response.json(body);
      },
    );

    const response = await handler(request('POST', { name: 'validated' }), undefined);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ name: 'validated' });
  });
});
