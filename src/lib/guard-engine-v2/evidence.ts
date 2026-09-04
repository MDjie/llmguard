import type { EvidenceRef } from '@guardllm/contracts';
import { mapViewRange, normalizationTransformNames } from './normalization';
import type { GuardDetectorContext, NormalizedView } from './types';

export function textEvidence(
  context: GuardDetectorContext,
  view: NormalizedView,
  normalizedStart: number,
  normalizedEnd: number,
  matchedText: string,
  maskedPreview?: string,
): EvidenceRef {
  const original = mapViewRange(view, normalizedStart, normalizedEnd);
  const transforms = normalizationTransformNames(view);
  return {
    viewId: view.id,
    start: original.start,
    end: original.end,
    normalizedStart,
    normalizedEnd,
    ...(transforms.length > 0 ? { normalizationTransforms: transforms } : {}),
    ...(maskedPreview === undefined ? {} : { maskedPreview }),
    contentHmac: context.evidenceHmac(matchedText),
  };
}
