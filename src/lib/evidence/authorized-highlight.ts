import { createHash } from 'node:crypto';
import type { AlertView } from '@/contracts/http/security-alerts';
import { segmentHighlightedText, type HighlightRange } from './location';
export function authorizedArchiveHighlights(content: unknown, reference: { purpose: string; sourceStepId?: string | null }, requestId: string, alerts: readonly Pick<AlertView,'sourceId'|'stage'|'evidence'>[]) {
  const views = new Map<string, { label: string; text: string; ranges: HighlightRange[] }>();
  let total = 0;
  for (const alert of alerts) {
    const input = alert.stage.startsWith('INPUT');
    if (input !== ['MODEL_INPUT','RECEIVED_INPUT'].includes(reference.purpose)) continue;
    if (reference.sourceStepId && reference.sourceStepId !== alert.sourceId) continue;
    for (const evidence of alert.evidence) for (const location of evidence.locations) {
      if (evidence.locationState !== 'VERIFIED' || location.artifactId !== requestId || location.contentVersion !== alert.sourceId || location.textStart === undefined || location.textEnd === undefined) continue;
      if (!location.contentPath.startsWith('/') || /~(?![01])/u.test(location.contentPath)) continue;
      let value: unknown = content;
      for (const token of location.contentPath.slice(1).split('/').map(part => part.replaceAll('~1','/').replaceAll('~0','~'))) {
        if (value === null || typeof value !== 'object' || !Object.hasOwn(value,token)) { value = undefined; break; }
        value = Reflect.get(value, token);
      }
      if (content && typeof content === 'object' && 'kind' in content && content.kind === 'PREPARED_DETECTION_CONTEXT' && 'segments' in content && Array.isArray(content.segments)) {
        const segment: unknown = content.segments.find((item: unknown) => Boolean(item && typeof item === 'object' && 'contentPath' in item && item.contentPath === location.contentPath && 'sourceDigest' in item && item.sourceDigest === location.sourceDigest));
        if (segment && typeof segment === 'object' && 'text' in segment) value = segment.text;
      }
      if (typeof value !== 'string' || value.length !== location.textLength || createHash('sha256').update(value).digest('hex') !== location.sourceDigest) continue;
      const key = location.contentPath + ':' + location.sourceDigest;
      let view = views.get(key);
      if (!view) { if (views.size >= 8 || total + value.length > 262144) continue; total += value.length; view = { label: location.contentPath, text: value, ranges: [] }; views.set(key, view); }
      if (view.ranges.length < 1000) view.ranges.push({ start: location.textStart, end: location.textEnd, evidenceId: evidence.evidenceId });
    }
  }
  return [...views.values()].flatMap(view => { try { return [{ label: view.label, parts: segmentHighlightedText(view.text, view.ranges) }]; } catch { return []; } });
}
