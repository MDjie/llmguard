import { createHmac, createPrivateKey, createPublicKey, randomUUID, sign, timingSafeEqual, verify } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import type { AuthenticatedPrincipal } from '@/lib/api-security';
import { signedAuthContextSchema } from '@/contracts/http/gateway-v2';
import type { AuthContext, SignedAuthContext } from '../../../packages/contracts/generated/typescript/gateway-v2';
import { loadMasterKey, openSecret, sealSecret, type MasterKey, type SecretEnvelope } from '@/lib/secrets';
import { canonicalJson, GatewayError, sha256 } from './protocol';
import { gatewaySetting } from './settings';
import { verifyIngress } from './transport';

const workloadSchema = z.record(z.string(), z.object({ secret: z.string().min(32), role: z.enum(['proxy','bff']), certificateSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict());
const publicKeysSchema = z.record(z.string(), z.string().min(32));
const nonceCache = new Map<string, number>();

export function evidenceHmac(value: string): string {
  const key = process.env.CONTENT_HASH_KEY;
  if (!key || Buffer.byteLength(key) < 32) throw new GatewayError('EVIDENCE_KEY_UNAVAILABLE', 503);
  return createHmac('sha256', key).update('gateway-evidence-v2\0').update(value).digest('hex');
}
export function signPayload(purpose: string, payload: unknown): { keyId: string; signature: string } {
  const keyId = process.env.GATEWAY_AUTH_KEY_ID;
  const key = gatewaySetting('GATEWAY_AUTH_SIGNING_PRIVATE_KEY', 'GATEWAY_AUTH_SIGNING_PRIVATE_KEY_FILE');
  if (!keyId || !key) throw new GatewayError('GATEWAY_SIGNING_KEY_UNAVAILABLE', 503);
  const privateKey = createPrivateKey(key);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new GatewayError('GATEWAY_SIGNING_ALGORITHM_INVALID', 503);
  return { keyId, signature: sign(null, Buffer.from(purpose + '\n' + canonicalJson(payload)), privateKey).toString('base64url') };
}
export function verifyPayload(purpose: string, payload: unknown, keyId: string, signature: string): void {
  const keys = publicKeysSchema.parse(JSON.parse(gatewaySetting('GATEWAY_AUTH_PUBLIC_KEYS_JSON', 'GATEWAY_AUTH_PUBLIC_KEYS_FILE') ?? '{}'));
  const pem = keys[keyId];
  if (!pem) throw new GatewayError('GATEWAY_SIGNING_KEY_UNTRUSTED', 401);
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(purpose + '\n' + canonicalJson(payload)), key, Buffer.from(signature, 'base64url'))) throw new GatewayError('GATEWAY_SIGNATURE_INVALID', 401);
}
export function issueAuthContext(context: AuthContext): SignedAuthContext {
  const signed = signPayload('gateway-auth-v2', context);
  if (signed.keyId !== context.keyId) throw new GatewayError('GATEWAY_SIGNING_KEY_CHANGED', 503);
  return { context, signature: signed.signature };
}
export function verifyAuthContext(value: unknown, now = Date.now()): SignedAuthContext {
  const auth = signedAuthContextSchema.parse(value);
  const context = auth.context;
  verifyPayload('gateway-auth-v2', context, context.keyId, auth.signature);
  if (context.issuer !== 'guard-control' || context.audience !== 'guard-gateway' || context.issuedAt > now + 1000 || context.expiresAt <= now || context.expiresAt > context.deadline || context.expiresAt - context.issuedAt > 600000) throw new GatewayError('AUTH_CONTEXT_EXPIRED_OR_INVALID', 401);
  return auth;
}

export function verifyWorkload(request: NextRequest, rawBody: string): { nodeId: string; role: 'proxy' | 'bff' } {
  verifyIngress(request);
  const keys = workloadSchema.parse(JSON.parse(gatewaySetting('GATEWAY_WORKLOAD_KEYS_JSON', 'GATEWAY_WORKLOAD_KEYS_FILE') ?? '{}'));
  const nodeId = request.headers.get('x-guard-workload') ?? '';
  const entry = keys[nodeId];
  const timestamp = request.headers.get('x-guard-workload-time') ?? '';
  const nonce = request.headers.get('x-guard-workload-nonce') ?? '';
  const signature = request.headers.get('x-guard-workload-signature') ?? '';
  const now = Date.now();
  if (!entry || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 30000 || !/^[a-zA-Z0-9_-]{16,128}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) throw new GatewayError('WORKLOAD_AUTHENTICATION_FAILED', 401);
  const peer = request.headers.get('x-guardllm-remote') ?? '';
  const insecureDevelopment = process.env.NODE_ENV !== 'production' && process.env.GATEWAY_INTERNAL_DEV_ALLOW_INSECURE === 'true' && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer);
  const peerCertificate = request.headers.get('x-guard-tls-client-sha256');
  if (!insecureDevelopment && (!entry.certificateSha256 || peerCertificate !== entry.certificateSha256)) throw new GatewayError('WORKLOAD_MTLS_REQUIRED', 401);
  const material = [request.method, request.nextUrl.pathname + request.nextUrl.search, timestamp, nonce, sha256(rawBody)].join('\n');
  const expected = createHmac('sha256', entry.secret).update(material).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new GatewayError('WORKLOAD_SIGNATURE_INVALID', 401);
  for (const [key, expires] of nonceCache) if (expires <= now) nonceCache.delete(key);
  const replayKey = nodeId + ':' + nonce;
  if (nonceCache.has(replayKey)) throw new GatewayError('WORKLOAD_REQUEST_REPLAYED', 409);
  if (nonceCache.size >= 32768) throw new GatewayError('WORKLOAD_NONCE_CAPACITY', 503);
  nonceCache.set(replayKey, now + 60000);
  return { nodeId, role: entry.role };
}

const assertionSchema = z.object({
  subject: z.string().min(1).max(128), tenantId: z.string().min(1).max(128), applicationId: z.string().min(1).max(128),
  tokenVersion: z.number().int().nonnegative(), requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int(), expiresAt: z.number().int(), nonce: z.string(), keyId: z.string(),
}).strict();
export type ConsoleAssertion = z.infer<typeof assertionSchema>;
export function issueConsoleAssertion(principal: AuthenticatedPrincipal, requestDigest: string): string {
  if (principal.authenticationMethod === 'service' || !principal.tenantId || !principal.applicationId || principal.tokenVersion === undefined) throw new GatewayError('CONSOLE_IDENTITY_REQUIRED', 401);
  const now = Date.now();
  const payload: ConsoleAssertion = { subject: principal.subject, tenantId: principal.tenantId, applicationId: principal.applicationId, tokenVersion: principal.tokenVersion,
    requestDigest, issuedAt: now, expiresAt: now + 5000, nonce: randomUUID(), keyId: process.env.GATEWAY_AUTH_KEY_ID ?? '' };
  const { signature } = signPayload('gateway-console-v2', payload);
  return Buffer.from(canonicalJson(payload)).toString('base64url') + '.' + signature;
}
export function verifyConsoleAssertion(token: string, requestDigest: string): ConsoleAssertion {
  const parts = token.split('.');
  if (parts.length !== 2) throw new GatewayError('CONSOLE_ASSERTION_INVALID', 401);
  const payload = assertionSchema.parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')));
  verifyPayload('gateway-console-v2', payload, payload.keyId, parts[1]);
  const now = Date.now();
  if (payload.requestDigest !== requestDigest || payload.issuedAt > now + 1000 || payload.expiresAt <= now || payload.expiresAt - payload.issuedAt > 5000) throw new GatewayError('CONSOLE_ASSERTION_EXPIRED_OR_CHANGED', 401);
  return payload;
}

function keyFor(id: string): MasterKey {
  const active = loadMasterKey();
  if (id === active.id) return active;
  const previous = publicKeysSchema.parse(JSON.parse(gatewaySetting('SECRET_MASTER_KEY_RING_JSON', 'SECRET_MASTER_KEY_RING_FILE') ?? '{}'))[id];
  if (!previous) throw new GatewayError('RECEIPT_KEY_UNAVAILABLE', 503);
  return loadMasterKey({ NODE_ENV: process.env.NODE_ENV, SECRET_MASTER_KEY: previous, SECRET_MASTER_KEY_ID: id });
}
/** Chunk bytes as base64 before sealing, so UTF-8 characters are never split/lost. */
export function sealReceipt(value: unknown, reference: string): SecretEnvelope[] {
  const bytes = Buffer.from(canonicalJson(JSON.parse(JSON.stringify(value))));
  if (bytes.length > 4194304) throw new GatewayError('RECEIPT_BUDGET_EXCEEDED', 413);
  const key = loadMasterKey(); const envelopes: SecretEnvelope[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) envelopes.push(sealSecret(bytes.subarray(offset, offset + 8192).toString('base64'), reference + ':' + envelopes.length, key));
  bytes.fill(0); return envelopes;
}
export function openReceipt(envelopes: readonly SecretEnvelope[], reference: string): unknown {
  const buffers = envelopes.map((envelope, i) => Buffer.from(openSecret(envelope, reference + ':' + i, keyFor(envelope.keyId)), 'base64'));
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); } finally { buffers.forEach((buffer) => buffer.fill(0)); }
}

/** Archive integrity follows the retained encryption-key ring, independently of short-lived gateway fingerprints. */
export function archiveContentHmac(value: string, keyId: string): string {
  return createHmac('sha256', keyFor(keyId).bytes).update('guard-archive-content-v1\0').update(value).digest('hex');
}
