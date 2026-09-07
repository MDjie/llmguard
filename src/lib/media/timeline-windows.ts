export interface TimedText { readonly text: string; readonly startMs: number; readonly endMs: number }

/** Overlapping, bounded windows preserve original segment timestamps. Oversized segments are
 * retained by individual detection but excluded from joint windows, with an explicit coverage gap.
 */
export function planTimelineWindows<T extends TimedText>(segments: readonly T[], options: {
  windowMs: number; strideMs?: number; maximumWindows?: number; maximumSegments?: number; maximumChars?: number;
}) {
  const windowMs = options.windowMs, strideMs = options.strideMs ?? Math.max(1, Math.floor(windowMs / 2));
  const maximumWindows = options.maximumWindows ?? 128, maximumSegments = options.maximumSegments ?? 256, maximumChars = options.maximumChars ?? 131072;
  if (![windowMs, strideMs, maximumWindows, maximumSegments, maximumChars].every(value => Number.isSafeInteger(value) && value > 0) ||
    strideMs > windowMs || windowMs > 60000 || maximumWindows > 512) throw new Error('MEDIA_WINDOW_BUDGET_INVALID');
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const reasons = new Set<string>();
  const valid = sorted.filter(segment => {
    if (!Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs) || segment.startMs < 0 || segment.endMs < segment.startMs) {
      reasons.add('MEDIA_TIMESTAMP_INVALID'); return false;
    }
    if (segment.endMs - segment.startMs > windowMs) { reasons.add('MEDIA_SEGMENT_EXCEEDS_WINDOW'); return false; }
    return Boolean(segment.text);
  });
  const anchor = valid[0]?.startMs ?? 0;
  const starts = new Set<number>();
  for (const segment of valid) {
    const latest = Math.floor((segment.startMs - anchor) / strideMs);
    const earliest = Math.max(0, Math.ceil((segment.endMs - windowMs - anchor) / strideMs));
    for (let index = earliest; index <= latest; index++) {
      if (starts.size >= maximumWindows && !starts.has(index)) { reasons.add('MEDIA_WINDOW_COUNT_EXCEEDED'); break; }
      starts.add(index);
    }
  }
  const windows = [...starts].sort((a, b) => a - b).map(index => {
    const startMs = anchor + index * strideMs, endMs = startMs + windowMs;
    const members: T[] = []; let chars = 0;
    for (const segment of valid) {
      if (segment.startMs < startMs || segment.endMs > endMs) continue;
      if (members.length >= maximumSegments || chars + segment.text.length + 1 > maximumChars) { reasons.add('MEDIA_WINDOW_CONTENT_BUDGET_EXCEEDED'); continue; }
      members.push(segment); chars += segment.text.length + 1;
    }
    return { startMs, endMs, segments: members };
  }).filter(window => window.segments.length > 0);
  const included = new Set(windows.flatMap(window => window.segments));
  if (valid.some(segment => !included.has(segment))) reasons.add('MEDIA_WINDOW_COVERAGE_GAP');
  return { windowMs, strideMs, windows, complete: reasons.size === 0, reasonCodes: [...reasons].sort() };
}
