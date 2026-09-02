import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  contextSignaturePayload,
  gatewayContextHeaders,
  GuardGatewayClient,
  parseSse,
} from '../../packages/sdk-typescript/src';

const secret = '0123456789abcdef0123456789abcdef';

describe('GuardLLM TypeScript SDK', () => {
  it('binds scope, principal, credential, trace, session and deadline to signature v3', () => {
    const deadline = Date.now() + 20_000;
    const identity = {
      tenantId: 'tenant-1',
      applicationId: 'app-1',
      principalId: 'user-1',
      credentialId: 'credential-1',
      requestId: 'request-123',
      traceId: 'trace-1234567890',
      sessionId: 'session-1',
      absoluteDeadlineEpochMs: deadline,
    };
    const headers = gatewayContextHeaders(identity, secret);
    const expected = createHmac('sha256', secret)
      .update(contextSignaturePayload(identity), 'utf8').digest('hex');
    expect(headers).toMatchObject({
      'X-Guard-Context-Version': '3',
      'X-Guard-Context-Signature': expected,
      'X-Principal-Id': 'user-1',
      'X-Credential-Id': 'credential-1',
      'X-Session-Id': 'session-1',
    });
    expect(contextSignaturePayload({ ...identity, traceId: 'trace-tampered-000' }))
      .not.toBe(contextSignaturePayload(identity));
  });

  it('parses fragmented multi-line SSE without yielding partial events', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message\ndata: {"a":'));
        controller.enqueue(encoder.encode('1}\ndata: second\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const events = [];
    for await (const event of parseSse(body)) events.push(event);
    expect(events).toEqual([
      { event: 'message', id: undefined, data: '{"a":1}\nsecond' },
      { event: undefined, id: undefined, data: '[DONE]' },
    ]);
  });

  it('sends a signed non-streaming OpenAI-compatible request', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        'X-Guard-Context-Version': '3',
        'X-Principal-Id': 'user-1',
        'X-Credential-Id': 'credential-1',
        'X-Session-Id': 'session-1',
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({ stream: false });
      return Response.json({ id: 'completion-1' });
    });
    const client = new GuardGatewayClient({
      baseUrl: 'http://localhost:8080',
      tenantId: 'tenant-1',
      applicationId: 'app-1',
      credentialId: 'credential-1',
      contextHmacSecret: secret,
      fetch: fetcher as typeof fetch,
    });
    await expect(client.chat({ messages: [] }, {
      requestId: 'request-123',
      traceId: 'trace-1234567890',
      sessionId: 'session-1',
      principalId: 'user-1',
    })).resolves.toEqual({ id: 'completion-1' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects direct evaluation with a mismatched tenant before network I/O', async () => {
    const fetcher = vi.fn();
    const client = new GuardGatewayClient({
      baseUrl: 'http://localhost:8080',
      tenantId: 'tenant-1',
      applicationId: 'app-1',
      contextHmacSecret: secret,
      guardApiKey: 'guard-key',
      fetch: fetcher as typeof fetch,
    });
    await expect(client.evaluate({
      contractVersion: '1.0',
      context: {
        traceId: 'trace-1234567890',
        requestId: 'request-123',
        tenantId: 'tenant-2',
        applicationId: 'app-1',
        direction: 'INPUT',
        absoluteDeadlineEpochMs: Date.now() + 20_000,
        policyBundleId: 'bundle-1',
      },
      content: { text: 'hello' },
    })).rejects.toThrow(/scope/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
