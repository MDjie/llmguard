import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, sha256 } from '@/lib/gateway-runtime/protocol';
import { signPayload } from '@/lib/gateway-runtime/security';

export const pinnedEndpointSchema = z.object({
  endpoint: z.string().url(), caFile: z.string().min(1), certificateFile: z.string().min(1), keyFile: z.string().min(1),
  serverCertificateSha256: z.string().regex(/^[a-f0-9]{64}$/),
  timeoutMs: z.number().int().min(100).max(60000), maximumResponseBytes: z.number().int().min(1024).max(2097152),
});
export function validatePinnedEndpoint(endpoint: string): void {
  const u = new URL(endpoint);
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.search) throw new Error('CONNECTOR_FIXED_HTTPS_REQUIRED');
}
/** Operator-owned endpoints only; no redirects, implicit retry or public URL input. */
export async function signedPinnedJson<T>(input: {
  config: z.infer<typeof pinnedEndpointSchema>; purpose: string; requestId: string; body: unknown; signal: AbortSignal; parse(value: unknown, requestDigest: string): T;
}): Promise<T> {
  const { config } = input; validatePinnedEndpoint(config.endpoint);
  const raw = canonicalJson(input.body), requestDigest = sha256(raw), auth = signPayload(input.purpose, input.body);
  const tls = { ca: readFileSync(config.caFile), cert: readFileSync(config.certificateFile), key: readFileSync(config.keyFile) };
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(config.timeoutMs)]);
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const call = request(config.endpoint, { method: 'POST', ...tls, agent: false, rejectUnauthorized: true, signal,
      checkServerIdentity(host, peer) {
        const invalid = checkServerIdentity(host, peer); if (invalid) return invalid;
        if (!peer.raw || createHash('sha256').update(peer.raw).digest('hex') !== config.serverCertificateSha256) return new Error('CONNECTOR_CERTIFICATE_MISMATCH');
      }, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'idempotency-key': input.requestId,
        'x-guard-request-digest': requestDigest, 'x-guard-connector-key-id': auth.keyId, 'x-guard-connector-signature': auth.signature },
    }, response => {
      const buffers: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > config.maximumResponseBytes) response.destroy(new Error('CONNECTOR_RESPONSE_TOO_LARGE')); else buffers.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200 || response.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new Error('CONNECTOR_RESPONSE_INVALID');
          resolve(input.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers))), requestDigest));
        } catch (error) { reject(error); }
      });
    });
    call.on('error', reject); call.end(raw);
  });
}
