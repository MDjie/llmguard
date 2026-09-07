import { describe, expect, it } from 'vitest';
import { validateRecheck } from '../../src/lib/gateway-runtime/recheck';
import { extractSegments, sha256 } from '../../src/lib/gateway-runtime/protocol';
import type { GatewayDecision } from '../../packages/contracts/generated/typescript/gateway-v2';

describe('exact transformation rechecks', () => {
  const input = extractSegments({ messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'phone 13800138000' }] }, 'INPUT', 1000);
  const segment = input[1];
  const decision: GatewayDecision = { contractVersion: '2.0', businessRequestId: 'request', stepId: 'step', decisionId: 'decision', snapshotId: 'snapshot', action: 'MASK', coverage: 'COMPLETE', status: 'SUCCEEDED', riskLevel: 'MEDIUM', reasonCodes: [], modelVersions: [], latencyMs: 1,
    transformPatches: [{ segmentId: segment.segmentId, contentPath: segment.contentPath, sourceDigest: segment.sourceDigest, start: 6, end: 17, replacement: '[PHONE]' }] };
  const changed = [input[0], { ...segment, text: 'phone [PHONE]', sourceDigest: sha256('phone [PHONE]') }];
  it('accepts only the approved transformation, including unchanged other messages', () => {
    expect(() => validateRecheck(input, decision, changed)).not.toThrow();
    expect(() => validateRecheck(input, decision, [{ ...input[0], text: 'changed' }, changed[1]])).toThrow('RECHECK_CONTENT_CHANGED');
    expect(() => validateRecheck(input, { ...decision, action: 'ALLOW' }, changed)).toThrow('RECHECK_NOT_AUTHORIZED');
    expect(() => validateRecheck(input, { ...decision, coverage: 'PARTIAL' }, changed)).toThrow('DETECTION_COVERAGE_INCOMPLETE');
  });
  it('binds safe responses to the exact inspected assistant content', () => {
    const safe = { ...decision, action: 'SAFE_RESPONSE' as const, safeResponse: '无法提供该内容。', transformPatches: [] };
    const output = extractSegments({ choices: [{ message: { role: 'assistant', content: safe.safeResponse } }] }, 'OUTPUT', 1000);
    expect(() => validateRecheck(input, safe, output)).not.toThrow();
    expect(() => validateRecheck(input, safe, [{ ...output[0], text: 'different' }])).toThrow('SAFE_RESPONSE_CHANGED');
  });
});
