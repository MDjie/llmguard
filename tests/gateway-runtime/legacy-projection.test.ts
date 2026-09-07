import { describe, expect, it } from 'vitest';
import type { GatewayRequest } from '../../packages/contracts/generated/typescript/gateway-v2';
import { resolveContextEnvelopes } from '../../src/lib/context-trust';
import { extractSegments } from '../../src/lib/gateway-runtime/protocol';
import { legacyRequest } from '../../src/lib/gateway-runtime/legacy-projection';

describe('structured source projection into GuardEngine', () => {
  it('covers separator bytes, preserves transformation offsets and never grants system authority', () => {
    const segments = extractSegments({ messages: [{ role: 'system', content: '' }, { role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }], response_format: { type: 'json_object' } }, 'INPUT', 1000);
    const body: GatewayRequest = { contractVersion: '2.0', businessRequestId: 'request', stepId: 'step', traceId: 'trace', stage: 'INPUT', streamSeq: 0, attemptKind: 'INITIAL', snapshotId: 'snapshot', deadline: 1000, segments,
      auth: { signature: 'test-only-not-verified-here', context: { contractVersion: '2.0', authContextId: 'auth', issuer: 'guard-control', audience: 'guard-gateway', keyId: 'test', issuedAt: 0, expiresAt: 1000, tenantId: 'tenant', applicationId: 'app', subjectId: 'user', authVersion: 1, businessRequestId: 'request', traceId: 'trace', requestDigest: 'a'.repeat(64), policy: { snapshotId: 'snapshot', bundleId: 'bundle', generation: 1, digest: 'b'.repeat(64) }, allowedModelRoutes: ['test'], permissions: ['guard:use'], dataBoundary: 'internal', deadline: 1000 } } };
    const projected = legacyRequest(body);
    const envelopes = resolveContextEnvelopes(projected.request, 100);
    expect(envelopes.map(item => item.instructionCapability)).not.toContain('ALLOWED');
    expect(envelopes.map(item => item.trustLevel)).toEqual(['UNTRUSTED','UNTRUSTED','UNTRUSTED']);
    expect(projected.spans[1].start).toBe(1);
    expect(projected.request.content.text?.slice(projected.spans[1].start, projected.spans[1].end)).toBe('hello');
    expect(envelopes[0].contentStart).toBe(0);
    expect(projected.request.context.authContextId).toBe('auth');
  });
});
