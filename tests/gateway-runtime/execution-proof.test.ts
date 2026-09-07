import { describe, expect, it } from 'vitest';
import type { ExecutionEvent, GatewayDecision } from '../../packages/contracts/generated/typescript/gateway-v2';
import { canonicalJson, extractSegments, sha256 } from '../../src/lib/gateway-runtime/protocol';
import { validateExecutionProof } from '../../src/lib/gateway-runtime/execution-proof';

describe('actual execution action evidence', () => {
  const before = extractSegments({ choices: [{ message: { role: 'assistant', content: 'phone 13800138000' } }] }, 'OUTPUT', 1000);
  const after = extractSegments({ choices: [{ message: { role: 'assistant', content: 'phone [PHONE]' } }] }, 'OUTPUT', 1000);
  const decision: GatewayDecision = { contractVersion: '2.0', businessRequestId: 'r', stepId: 'initial', decisionId: 'mask', snapshotId: 'snapshot', action: 'MASK', coverage: 'COMPLETE', status: 'SUCCEEDED', riskLevel: 'MEDIUM', reasonCodes: [], modelVersions: [], latencyMs: 1,
    transformPatches: [{ segmentId: before[0].segmentId, contentPath: before[0].contentPath, sourceDigest: before[0].sourceDigest, start: 6, end: 17, replacement: '[PHONE]' }] };
  const checked = { ...decision, stepId: 'recheck', decisionId: 'allow', action: 'ALLOW' as const, transformPatches: [] };
  const event: ExecutionEvent = { eventSeq: 3, kind: 'RELEASE_INTENT', snapshotId: 'snapshot', stepId: 'recheck', decisionId: 'mask', recheckDecisionId: 'allow', actualAction: 'MASK', rangeStart: 0, rangeEnd: 13, payloadDigest: sha256(canonicalJson(after)) };
  it('binds the actual MASK action to both original and approving decisions', () => {
    const final = { decision: checked, segments: after }, original = { decision, segments: before };
    expect(() => validateExecutionProof(event, final, original)).not.toThrow();
    expect(() => validateExecutionProof({ ...event, actualAction: 'ALLOW' }, final, original)).toThrow('EXECUTION_ACTION_BINDING_INVALID');
    expect(() => validateExecutionProof({ ...event, recheckDecisionId: 'different' }, final, original)).toThrow('EXECUTION_ACTION_BINDING_INVALID');
    expect(() => validateExecutionProof(event, { ...final, segments: before }, original)).toThrow('RECHECK_CONTENT_CHANGED');
    expect(() => validateExecutionProof(event, final)).toThrow('EXECUTION_ACTION_BINDING_INVALID');
  });
  it('rejects incomplete, blocked and altered release bytes', () => {
    expect(() => validateExecutionProof(event, { decision: { ...checked, coverage: 'PARTIAL' }, segments: after })).toThrow('DETECTION_COVERAGE_INCOMPLETE');
    expect(() => validateExecutionProof(event, { decision: { ...checked, action: 'BLOCK' }, segments: after })).toThrow('EXECUTION_RECHECK_REQUIRED');
    expect(() => validateExecutionProof({ ...event, payloadDigest: sha256('wrong') }, { decision: checked, segments: after }, { decision, segments: before })).toThrow('EXECUTION_CONTENT_MISMATCH');
  });
});
