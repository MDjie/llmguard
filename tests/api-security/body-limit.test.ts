import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createApiSecurity,
  formDataWithLimit,
} from '../../src/lib/api-security';

const policy = {
  id: 'test-body-limit',
  windowMs: 60_000,
  maxRequests: 100,
  scope: 'principal' as const,
};

// 分块传输（无 Content-Length）的请求体：预检 assertBodyLimit 对其不生效，
// 只能靠读取路径上的字节设限兜底
function chunkedRequest(body: string): NextRequest {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = encoder.encode(body);
      const midpoint = Math.ceil(bytes.length / 2);
      controller.enqueue(bytes.slice(0, midpoint));
      controller.enqueue(bytes.slice(midpoint));
      controller.close();
    },
  });
  return new NextRequest('http://localhost/api/example', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  });
}

describe('chunked request body limits', () => {
  it('rejects an oversized chunked JSON body through the schema path', async () => {
    const { withApiSecurity } = createApiSecurity();
    const handler = withApiSecurity(
      {
        public: true,
        bodySchema: z.object({ data: z.string() }),
        maxBodyBytes: 1_024,
        auditEvent: 'test.body.limit.json',
        rateLimitPolicy: policy,
      },
      async ({ body }) => Response.json({ ok: true, size: body.data.length }),
    );

    const response = await handler(
      chunkedRequest(JSON.stringify({ data: 'x'.repeat(4_096) })),
      undefined,
    );

    expect(response.status).toBe(413);
    const problem = await response.json();
    expect(problem.code).toBe('REQUEST_BODY_TOO_LARGE');
  });

  it('allows a chunked JSON body within the limit', async () => {
    const { withApiSecurity } = createApiSecurity();
    const handler = withApiSecurity(
      {
        public: true,
        bodySchema: z.object({ data: z.string() }),
        maxBodyBytes: 1_024,
        auditEvent: 'test.body.limit.ok',
        rateLimitPolicy: policy,
      },
      async ({ body }) => Response.json({ ok: true, size: body.data.length }),
    );

    const response = await handler(
      chunkedRequest(JSON.stringify({ data: 'small payload' })),
      undefined,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it('enforces the limit when a legacy handler reads request.json() itself', async () => {
    const { withApiSecurity } = createApiSecurity();
    const handler = withApiSecurity(
      {
        public: true,
        maxBodyBytes: 512,
        auditEvent: 'test.body.limit.legacy',
        rateLimitPolicy: policy,
      },
      async ({ request }) => {
        const parsed: unknown = await request.json();
        return Response.json({ ok: true, size: JSON.stringify(parsed).length });
      },
    );

    const response = await handler(
      chunkedRequest(JSON.stringify({ data: 'x'.repeat(2_048) })),
      undefined,
    );

    expect(response.status).toBe(413);
    const problem = await response.json();
    expect(problem.code).toBe('REQUEST_BODY_TOO_LARGE');
  });

  it('rejects an oversized multipart body inside formDataWithLimit', async () => {
    const request = new Request('http://localhost/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=guard' },
      body: `--guard\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\n${'a'.repeat(512)}\r\n--guard--\r\n`,
    });

    await expect(formDataWithLimit(request, 64)).rejects.toMatchObject({
      status: 413,
      code: 'REQUEST_BODY_TOO_LARGE',
    });
  });

  it('parses a multipart body within the limit inside formDataWithLimit', async () => {
    const request = new Request('http://localhost/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=guard' },
      body: '--guard\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--guard--\r\n',
    });

    const formData = await formDataWithLimit(request, 4_096);
    const file = formData.get('file');
    expect(file).toBeInstanceOf(File);
    expect(await (file as File).text()).toBe('hello');
  });
});
