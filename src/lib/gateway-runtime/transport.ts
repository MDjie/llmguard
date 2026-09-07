import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { GatewayError } from './protocol';

/** Prevent direct standalone-server callers from forging socket metadata. */
export function verifyIngress(request: NextRequest): void {
  const key = process.env.GATEWAY_INGRESS_SECRET;
  const timestamp = request.headers.get('x-guard-ingress-time') ?? '';
  const proof = request.headers.get('x-guard-ingress-proof') ?? '';
  if (!key || key.length < 32 || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 30000 || !/^[a-f0-9]{64}$/.test(proof)) throw new GatewayError('TRUSTED_INGRESS_REQUIRED', 401);
  const material = [request.method, request.nextUrl.pathname + request.nextUrl.search, request.headers.get('x-guardllm-remote') ?? '', request.headers.get('x-guard-tls-client-sha256') ?? '', timestamp, request.headers.get('x-guard-workload-signature') ?? ''].join('\n');
  if (!timingSafeEqual(createHmac('sha256', key).update(material).digest(), Buffer.from(proof, 'hex'))) throw new GatewayError('INGRESS_PROOF_INVALID', 401);
}
