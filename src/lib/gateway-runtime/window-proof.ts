import type { ContentSegment, WindowInspection, WindowPolicy } from '../../../packages/contracts/generated/typescript/gateway-v2';
import { GatewayError, sha256 } from './protocol';

export function windowReleaseSegments(segments: readonly ContentSegment[], window: WindowInspection): ContentSegment[] {
  if (segments.length !== 1) throw new GatewayError('WINDOW_TEXT_ONLY_REQUIRED', 422);
  const segment = segments[0];
  if (segment.role !== 'assistant' || segment.sourceType !== 'MODEL' || segment.contentPath !== '/choices/0/message/content' || segment.sourceDigest !== sha256(segment.text)) throw new GatewayError('WINDOW_TEXT_ONLY_REQUIRED', 422);
  const start = window.releaseStart - window.contextStart, end = window.releaseEnd - window.contextStart;
  if (start < 0 || end < start || end > segment.text.length || (!window.final && start === end)) throw new GatewayError('WINDOW_RANGE_INVALID', 403);
  for (const offset of [start, end]) if (offset > 0 && offset < segment.text.length && /[\uD800-\uDBFF]/.test(segment.text[offset - 1]) && /[\uDC00-\uDFFF]/.test(segment.text[offset])) throw new GatewayError('WINDOW_UNICODE_BOUNDARY_INVALID', 403);
  const text = segment.text.slice(start, end);
  return [{ ...segment, text, sourceDigest: sha256(text) }];
}

export function validateWindowInspection(segments: readonly ContentSegment[], window: WindowInspection, policy: WindowPolicy): void {
  windowReleaseSegments(segments, window);
  const text = segments[0].text, end = window.contextStart + text.length;
  // One extra UTF-16 code unit is permitted to keep a surrogate pair intact.
  if (window.contextStart > Math.max(0, window.releaseStart - policy.contextChars) || window.contextStart < Math.max(0, window.releaseStart - policy.contextChars - 1)
    || text.length > policy.contextChars + policy.chunkChars + policy.holdbackChars + 2) throw new GatewayError('WINDOW_CONTEXT_INVALID', 403);
  if (window.final ? window.releaseEnd !== end : end - window.releaseEnd < policy.holdbackChars) throw new GatewayError('WINDOW_HOLDBACK_INVALID', 403);
  if (!window.final && window.releaseEnd - window.releaseStart < policy.chunkChars - 1) throw new GatewayError('WINDOW_RELEASE_TOO_SMALL', 403);
}

export function validateWindowContinuation(previous: { segments: ContentSegment[]; window: WindowInspection } | undefined, segments: readonly ContentSegment[], window: WindowInspection): void {
  if (!previous) {
    if (window.contextStart !== 0 || window.releaseStart !== 0) throw new GatewayError('WINDOW_SEQUENCE_GAP', 409);
    return;
  }
  if (previous.window.final || previous.window.releaseEnd !== window.releaseStart) throw new GatewayError('WINDOW_SEQUENCE_GAP', 409);
  const end = Math.min(previous.window.contextStart + previous.segments[0].text.length, window.contextStart + segments[0].text.length);
  if (end < window.releaseStart || previous.segments[0].text.slice(window.contextStart - previous.window.contextStart, end - previous.window.contextStart) !== segments[0].text.slice(0, end - window.contextStart)) throw new GatewayError('WINDOW_CONTENT_CHANGED', 409);
}
