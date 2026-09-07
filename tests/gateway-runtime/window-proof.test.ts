import { describe, expect, it } from 'vitest';
import { extractSegments, canonicalJson, sha256 } from '../../src/lib/gateway-runtime/protocol';
import { validateWindowInspection, validateWindowContinuation, windowReleaseSegments } from '../../src/lib/gateway-runtime/window-proof';
import { validateExecutionProof } from '../../src/lib/gateway-runtime/execution-proof';
import type { GatewayDecision, WindowPolicy } from '../../packages/contracts/generated/typescript/gateway-v2';

const policy: WindowPolicy = { configurationDigest: 'd'.repeat(64), qualificationId: 'test', qualificationExpiresAt: 9e12, contextChars: 2048, chunkChars: 1024, holdbackChars: 256 };
const segments = (text: string) => extractSegments({ choices: [{ message: { role: 'assistant', content: text } }] }, 'OUTPUT', 30000);
describe('window release proof', () => {
  it('holds inspected suffix and hashes only the authorized released bytes', () => {
    const inspected = segments('a'.repeat(1024) + 'tail'.repeat(64)), window = { contextStart: 0, releaseStart: 0, releaseEnd: 1024, final: false };
    validateWindowInspection(inspected, window, policy);
    const released = windowReleaseSegments(inspected, window);
    expect(released[0].text).toBe('a'.repeat(1024));
    const decision: GatewayDecision = { contractVersion: '2.0', businessRequestId: 'r', stepId: 's', decisionId: 'd', snapshotId: 'snapshot', action: 'ALLOW', coverage: 'COMPLETE', status: 'SUCCEEDED', riskLevel: 'NONE', reasonCodes: [], modelVersions: [], latencyMs: 1, transformPatches: [] };
    const event = { eventSeq: 3, kind: 'RELEASE_INTENT' as const, snapshotId: 'snapshot', stepId: 's', decisionId: 'd', actualAction: 'ALLOW' as const, rangeStart: 0, rangeEnd: 1024, payloadDigest: sha256(canonicalJson(released)) };
    expect(() => validateExecutionProof(event, { decision, segments: inspected, window })).not.toThrow();
    expect(() => validateExecutionProof({ ...event, rangeEnd: 1280 }, { decision, segments: inspected, window })).toThrow('EXECUTION_COVERAGE_RANGE_INVALID');
    expect(() => validateExecutionProof({ ...event, payloadDigest: sha256(canonicalJson(inspected)) }, { decision, segments: inspected, window })).toThrow('EXECUTION_CONTENT_MISMATCH');
  });
  it('rejects missing holdback, absent context, multi-field and split surrogate release', () => {
    expect(() => validateWindowInspection(segments('a'.repeat(1100)), { contextStart: 0, releaseStart: 0, releaseEnd: 1024, final: false }, policy)).toThrow('WINDOW_HOLDBACK_INVALID');
    expect(() => validateWindowInspection(segments('a'.repeat(1280)), { contextStart: 1024, releaseStart: 1024, releaseEnd: 2048, final: false }, policy)).toThrow('WINDOW_CONTEXT_INVALID');
    expect(() => windowReleaseSegments([...segments('a'), ...segments('b')], { contextStart: 0, releaseStart: 0, releaseEnd: 1, final: true })).toThrow('WINDOW_TEXT_ONLY_REQUIRED');
    expect(() => windowReleaseSegments(segments('a😀b'), { contextStart: 0, releaseStart: 0, releaseEnd: 2, final: false })).toThrow('WINDOW_UNICODE_BOUNDARY_INVALID');
  });
  it('binds overlapping text, monotonic ranges and a single terminal window', () => {
    const prior = { segments: segments('a'.repeat(1024) + 'b'.repeat(256)), window: { contextStart: 0, releaseStart: 0, releaseEnd: 1024, final: false } };
    const next = { contextStart: 0, releaseStart: 1024, releaseEnd: 2048, final: false };
    expect(() => validateWindowContinuation(prior, segments('a'.repeat(1024) + 'b'.repeat(256) + 'c'.repeat(1280)), next)).not.toThrow();
    expect(() => validateWindowContinuation(prior, segments('z'.repeat(2560)), next)).toThrow('WINDOW_CONTENT_CHANGED');
    expect(() => validateWindowContinuation(prior, prior.segments, { ...next, releaseStart: 1000 })).toThrow('WINDOW_SEQUENCE_GAP');
    expect(() => validateWindowContinuation({ ...prior, window: { ...prior.window, final: true } }, prior.segments, next)).toThrow('WINDOW_SEQUENCE_GAP');
    expect(() => validateWindowContinuation(undefined, prior.segments, next)).toThrow('WINDOW_SEQUENCE_GAP');
  });
  it('allows final tail only with exact completion coverage', () => {
    const tail = segments('a'.repeat(1400)), window = { contextStart: 0, releaseStart: 1024, releaseEnd: 1400, final: true };
    expect(() => validateWindowInspection(tail, window, policy)).not.toThrow();
    expect(() => validateWindowInspection(tail, { ...window, releaseEnd: 1300 }, policy)).toThrow('WINDOW_HOLDBACK_INVALID');
  });
});
