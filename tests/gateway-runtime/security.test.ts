import { beforeEach, describe, expect, it } from 'vitest';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { NextRequest } from 'next/server';
import { canonicalJson, sha256 } from '../../src/lib/gateway-runtime/protocol';
import { evidenceHmac, openReceipt, sealReceipt, signPayload, verifyPayload, verifyWorkload } from '../../src/lib/gateway-runtime/security';

describe('gateway workload identity and encrypted receipts', () => {
  beforeEach(() => {
    const keys = generateKeyPairSync('ed25519');
    process.env.GATEWAY_AUTH_KEY_ID = 'test-k1';
    process.env.GATEWAY_AUTH_SIGNING_PRIVATE_KEY = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    process.env.GATEWAY_AUTH_PUBLIC_KEYS_JSON = JSON.stringify({ 'test-k1': keys.publicKey.export({ format: 'pem', type: 'spki' }).toString() });
    process.env.GATEWAY_INGRESS_SECRET = 'ingress-proof-key-12345678901234567890';
    process.env.GATEWAY_WORKLOAD_KEYS_JSON = JSON.stringify({ proxy1: { secret: 'workload-key-1234567890123456789012345', role: 'proxy', certificateSha256: 'a'.repeat(64) } });
    process.env.CONTENT_HASH_KEY = 'evidence-key-1234567890123456789012345';
    process.env.SECRET_MASTER_KEY_ID = 'receipt1';
    process.env.SECRET_MASTER_KEY = Buffer.alloc(32, 1).toString('base64');
    process.env.GATEWAY_INTERNAL_DEV_ALLOW_INSECURE = 'false';
  });
  it('binds Ed25519 signatures to purpose and exact payload', () => {
    const value = { request: 'one', deadline: 1788760000000 };
    const signed = signPayload('gateway-auth-v2', value);
    expect(() => verifyPayload('gateway-auth-v2', value, signed.keyId, signed.signature)).not.toThrow();
    expect(() => verifyPayload('gateway-auth-v2', { ...value, request: 'two' }, signed.keyId, signed.signature)).toThrow('GATEWAY_SIGNATURE_INVALID');
    expect(() => verifyPayload('gateway-snapshot-v2', value, signed.keyId, signed.signature)).toThrow('GATEWAY_SIGNATURE_INVALID');
  });
  it('requires socket attestation, certificate pin and fresh request-bound nonce', () => {
    const raw = canonicalJson({ request: 'test' });
    const timestamp = String(Date.now()), nonce = 'test-nonce-unique-123456';
    const workload = createHmac('sha256', 'workload-key-1234567890123456789012345').update(['POST','/api/internal/gateway/authorize',timestamp,nonce,sha256(raw)].join('\n')).digest('hex');
    const headers = new Headers({ 'x-guard-workload': 'proxy1', 'x-guard-workload-time': timestamp, 'x-guard-workload-nonce': nonce, 'x-guard-workload-signature': workload,
      'x-guardllm-remote': '127.0.0.1', 'x-guard-tls-client-sha256': 'a'.repeat(64), 'x-guard-ingress-time': timestamp });
    const make = () => new NextRequest('https://control/api/internal/gateway/authorize', { method: 'POST', headers, body: raw });
    expect(() => verifyWorkload(make(), raw)).toThrow('TRUSTED_INGRESS_REQUIRED');
    const proof = createHmac('sha256', process.env.GATEWAY_INGRESS_SECRET!).update(['POST','/api/internal/gateway/authorize','127.0.0.1','a'.repeat(64),timestamp,workload].join('\n')).digest('hex');
    headers.set('x-guard-ingress-proof', proof);
    expect(() => verifyWorkload(make(), raw + ' ')).toThrow('WORKLOAD_SIGNATURE_INVALID');
    expect(verifyWorkload(make(), raw)).toEqual({ nodeId: 'proxy1', role: 'proxy' });
    expect(() => verifyWorkload(make(), raw)).toThrow('WORKLOAD_REQUEST_REPLAYED');
    headers.set('x-guard-tls-client-sha256', 'b'.repeat(64));
    expect(() => verifyWorkload(make(), raw)).toThrow('INGRESS_PROOF_INVALID');
  });
  it('keeps long Unicode receipts encrypted and supports retained decryption keys', () => {
    const input = { text: '😀敏感文本'.repeat(4000) };
    const encrypted = sealReceipt(input, 'request-step-1');
    expect(JSON.stringify(encrypted)).not.toContain('敏感');
    expect(openReceipt(encrypted, 'request-step-1')).toEqual(input);
    expect(() => openReceipt(encrypted, 'request-step-2')).toThrow();
    process.env.SECRET_MASTER_KEY_RING_JSON = JSON.stringify({ receipt1: process.env.SECRET_MASTER_KEY });
    process.env.SECRET_MASTER_KEY_ID = 'receipt2'; process.env.SECRET_MASTER_KEY = Buffer.alloc(32, 2).toString('base64');
    expect(openReceipt(encrypted, 'request-step-1')).toEqual(input);
    expect(evidenceHmac(input.text)).not.toBe(sha256(input.text));
  });
});
