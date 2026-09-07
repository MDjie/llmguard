import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuthenticatedPrincipal } from '@/lib/api-security';
import { canonicalJson, GatewayError, sha256 } from './protocol';
import { issueConsoleAssertion } from './security';

const replySchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) });
export async function callGatewayConsole(principal: AuthenticatedPrincipal, modelRoute: string, messages: readonly { role: string; content: string }[], signal: AbortSignal, sessionId?: string, idempotencyKey?: string) {
  const configured = process.env.GATEWAY_PROXY_URL;
  if (!configured) throw new GatewayError('GATEWAY_PROXY_NOT_CONFIGURED', 503);
  const url = new URL('/v1/chat/completions', configured);
  if (url.username || url.password) throw new GatewayError('GATEWAY_PROXY_CONFIGURATION_INVALID', 503);
  const insecure = process.env.NODE_ENV !== 'production' && process.env.GATEWAY_INTERNAL_DEV_ALLOW_INSECURE === 'true' && ['127.0.0.1','[::1]','localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && insecure)) throw new GatewayError('GATEWAY_PROXY_TLS_REQUIRED', 503);
  const cert = process.env.GATEWAY_CONSOLE_TLS_CERT, key = process.env.GATEWAY_CONSOLE_TLS_KEY, ca = process.env.GATEWAY_CONSOLE_TLS_CA;
  if (!insecure && (!cert || !key || !ca)) throw new GatewayError('GATEWAY_CONSOLE_MTLS_REQUIRED', 503);
  const started = Date.now();
  const body = { model: modelRoute, messages, stream: false };
  const raw = JSON.stringify(body);
  const assertion = issueConsoleAssertion(principal, sha256(canonicalJson(body)));
  const requestId = randomUUID();
  const combined = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  return new Promise<{ content: string; latencyMs: number; gateway: { requestId: string; snapshotId: string; inputAction: string; outputAction: string; decisionId: string } }>((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(url, { method: 'POST', signal: combined, ...(cert && key && ca ? { cert: readFileSync(cert), key: readFileSync(key), ca: readFileSync(ca), rejectUnauthorized: true } : {}),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-guard-console-assertion': assertion, 'x-request-id': requestId,
        'x-guard-deadline': String(started + 59000), ...(sessionId ? { 'x-session-id': sessionId } : {}), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) } }, response => {
      const chunks: Buffer[] = []; let length = 0;
      response.on('data', (chunk: Buffer) => { length += chunk.byteLength; if (length > 4194304) response.destroy(new GatewayError('GATEWAY_RESPONSE_TOO_LARGE', 502)); else chunks.push(chunk); });
      response.on('error', () => reject(new GatewayError('GATEWAY_RESPONSE_INTERRUPTED', 502)));
      response.on('end', () => {
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200) {
            const failure = z.object({ error: z.object({ code: z.string().regex(/^[A-Z0-9_]{1,128}$/) }) }).safeParse(value);
            throw new GatewayError(failure.success ? failure.data.error.code : 'GATEWAY_EXECUTION_FAILED', response.statusCode ?? 503);
          }
          const header = (name: string) => { const value = response.headers[name]; if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new GatewayError('GATEWAY_EXECUTION_RECEIPT_MISSING', 502); return value; };
          resolve({ content: replySchema.parse(value).choices[0].message.content, latencyMs: Date.now() - started,
            gateway: { requestId: header('x-request-id'), snapshotId: header('x-guard-snapshot-id'), inputAction: header('x-guard-input-action'), outputAction: header('x-guard-output-action'), decisionId: header('x-guard-decision-id') } });
        } catch (error) { reject(error instanceof GatewayError ? error : new GatewayError('GATEWAY_RESPONSE_INVALID', 502)); }
      });
    });
    request.on('error', () => reject(new GatewayError(combined.aborted ? 'GATEWAY_CANCELLED_OR_TIMED_OUT' : 'GATEWAY_UNAVAILABLE', combined.aborted ? 504 : 503)));
    request.end(raw);
  });
}
