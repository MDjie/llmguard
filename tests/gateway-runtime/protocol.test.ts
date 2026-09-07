import { describe, expect, it } from 'vitest';
import { applyPatches, canonicalJson, extractSegments, policyBucket, sha256 } from '../../src/lib/gateway-runtime/protocol';

describe('gateway 2.0 canonical and transformation contract', () => {
  it('canonicalizes object order, decimal notation and UTF-16 keys', () => {
    expect(canonicalJson({ z: -0, a: 1e-7, emoji: '😀' })).toBe('{"a":0.0000001,"emoji":"😀","z":0}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(policyBucket('tenant', 'app', 'session')).toBe(policyBucket('tenant','app','session'));
    expect(() => canonicalJson('\ud800')).toThrow('INVALID_UNICODE');
  });
  it('writes mapped patches to the correct message and preserves other fields', () => {
    const request = { model: 'test', messages: [{ role: 'system', content: '规则' }, { role: 'user', content: [{ type: 'text', text: '😀联系：13800138000' }] }], temperature: 0.2 };
    const segments = extractSegments(request, 'INPUT', 1000);
    const segment = segments[1];
    const patch = { segmentId: segment.segmentId, contentPath: segment.contentPath, sourceDigest: segment.sourceDigest, start: 5, end: 16, replacement: '[PHONE]' };
    expect(applyPatches(request, segments, [patch])).toEqual({ ...request, messages: [request.messages[0], { role: 'user', content: [{ type: 'text', text: '😀联系：[PHONE]' }] }] });
    expect(() => applyPatches(request, segments, [{ ...patch, start: 1 }])).toThrow('INVALID_UNICODE');
    expect(() => applyPatches(request, segments, [patch, patch])).toThrow('TRANSFORM_RANGE_OVERLAP');
    expect(() => applyPatches(request, segments, [{ ...patch, sourceDigest: sha256('changed') }])).toThrow('TRANSFORM_BINDING_MISMATCH');
  });
  it('does not silently truncate or allow unsupported payloads', () => {
    expect(() => extractSegments({ messages: [{ role: 'user', content: 'abcdef' }] }, 'INPUT', 4)).toThrow('CONTENT_BUDGET_EXCEEDED');
    expect(() => extractSegments({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'x' }] }] }, 'INPUT', 100)).toThrow('ARTIFACT_PIPELINE_REQUIRED');
    expect(() => extractSegments({ choices: [{ message: { role: 'assistant', content: null, audio: { data: 'hidden' } } }] }, 'OUTPUT', 100)).toThrow('MESSAGE_FIELD_UNSUPPORTED');
  });
});
