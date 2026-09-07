import { NextRequest } from 'next/server';
import { z } from 'zod';
import { GatewayError } from './protocol';
import { verifyWorkload } from './security';

export function internalGatewayRoute<T>(schema: z.ZodType<T>, handler: (body: T, request: NextRequest, nodeId: string) => Promise<unknown>) {
  return async (request: NextRequest): Promise<Response> => {
    let requestId = request.headers.get('x-request-id') ?? '';
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) requestId = 'unknown';
    try {
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = []; let length = 0;
      if (reader) try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 4194304) { await reader.cancel(); throw new GatewayError('BODY_TOO_LARGE', 413); } chunks.push(value); }
      } finally { reader.releaseLock(); }
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      const workload = verifyWorkload(request, raw);
      if (workload.role !== 'proxy') throw new GatewayError('PROXY_WORKLOAD_REQUIRED', 403);
      const body = schema.parse(raw ? JSON.parse(raw) : {});
      const result = await handler(body, request, workload.nodeId);
      return result instanceof Response ? result : Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      const status = error instanceof GatewayError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503;
      const code = error instanceof GatewayError ? error.code : status === 400 ? 'GATEWAY_CONTRACT_INVALID' : 'GATEWAY_DEPENDENCY_UNAVAILABLE';
      return Response.json({ contractVersion: '2.0', code, requestId, traceId: requestId, retryable: status >= 500 }, { status, headers: { 'Cache-Control': 'no-store' } });
    }
  };
}
