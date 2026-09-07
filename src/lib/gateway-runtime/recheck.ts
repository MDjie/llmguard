import type { ContentSegment, GatewayDecision } from '../../../packages/contracts/generated/typescript/gateway-v2';
import { assertUnicode, canonicalJson, GatewayError, requireCompleteDecision, sha256 } from './protocol';

/** Recheck is a single, exact continuation of an earlier complete decision. */
export function validateRecheck(original: readonly ContentSegment[], decision: GatewayDecision, actual: readonly ContentSegment[]): void {
  requireCompleteDecision(decision);
  if (decision.action === 'SAFE_RESPONSE') {
    if (typeof decision.safeResponse !== 'string' || actual.length !== 1) throw new GatewayError('SAFE_RESPONSE_RECHECK_INVALID', 403);
    const segment = actual[0];
    if (segment.text !== decision.safeResponse || segment.role !== 'assistant' || segment.sourceType !== 'MODEL' || segment.contentPath !== '/choices/0/message/content'
      || segment.sourceDigest !== sha256(segment.text) || segment.segmentId !== sha256(segment.contentPath).slice(0, 32)) throw new GatewayError('SAFE_RESPONSE_CHANGED', 403);
    return;
  }
  if (!['MASK','REWRITE'].includes(decision.action) || !decision.transformPatches.length) throw new GatewayError('RECHECK_NOT_AUTHORIZED', 403);
  const pending = new Set(decision.transformPatches);
  const expected = original.map((segment) => {
    const patches = decision.transformPatches.filter((p) => p.segmentId === segment.segmentId).sort((a,b) => a.start - b.start);
    if (!patches.length) return segment;
    let end = 0;
    for (const patch of patches) {
      if (patch.sourceDigest !== segment.sourceDigest || patch.contentPath !== segment.contentPath || segment.sourceType === 'TOOL' || patch.start < end || patch.start >= patch.end || patch.end > segment.text.length) throw new GatewayError('RECHECK_PATCH_INVALID', 403);
      assertUnicode(segment.text.slice(0, patch.start)); assertUnicode(segment.text.slice(patch.end)); assertUnicode(patch.replacement);
      end = patch.end; pending.delete(patch);
    }
    let text = segment.text;
    for (const patch of [...patches].reverse()) text = text.slice(0, patch.start) + patch.replacement + text.slice(patch.end);
    return { ...segment, text, sourceDigest: sha256(text) };
  });
  if (pending.size || canonicalJson(expected) !== canonicalJson(actual)) throw new GatewayError('RECHECK_CONTENT_CHANGED', 403);
}
