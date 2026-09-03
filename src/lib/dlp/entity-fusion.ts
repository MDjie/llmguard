import type { GuardAction, Observation } from '@guardllm/contracts';

export type DlpRecognizerSource =
  | 'DETERMINISTIC'
  | 'CUSTOM_DICTIONARY'
  | 'PRESIDIO_SHADOW'
  | 'OCR';

export interface DlpEntityCandidate {
  readonly entityType: string;
  readonly start: number;
  readonly end: number;
  readonly confidence: number;
  readonly recognizerId: string;
  readonly recognizerVersion: string;
  readonly source: DlpRecognizerSource;
  readonly deterministicValidation: boolean;
  readonly contentHmac?: string;
}

export interface PresidioEntityCandidate {
  readonly entityType: string;
  readonly start: number;
  readonly end: number;
  readonly score: number;
  readonly recognizerId?: string;
  readonly recognizerVersion: string;
}

export interface FusedDlpEntity extends DlpEntityCandidate {
  readonly action: GuardAction;
  readonly corroboratedBy: readonly string[];
  readonly conflictingRecognizers: readonly string[];
}

export interface DlpFusionResult {
  readonly entities: readonly FusedDlpEntity[];
  readonly degradationEvidence: readonly string[];
}

export interface DlpFusionOptions {
  readonly actionByEntityType: Readonly<Record<string, GuardAction>>;
  readonly defaultAction: GuardAction;
  readonly presidioAvailable: boolean;
  readonly maximumCandidates?: number;
}

const SOURCE_PRIORITY: Readonly<Record<DlpRecognizerSource, number>> = {
  DETERMINISTIC: 4,
  CUSTOM_DICTIONARY: 3,
  PRESIDIO_SHADOW: 2,
  OCR: 1,
};

function validateCandidate(candidate: DlpEntityCandidate): void {
  if (!candidate.entityType || !candidate.recognizerId || !candidate.recognizerVersion) {
    throw new Error('DLP_ENTITY_IDENTITY_REQUIRED');
  }
  if (!Number.isSafeInteger(candidate.start) || !Number.isSafeInteger(candidate.end) ||
      candidate.start < 0 || candidate.end <= candidate.start) {
    throw new Error('DLP_ENTITY_RANGE_INVALID');
  }
  if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
    throw new Error('DLP_ENTITY_CONFIDENCE_INVALID');
  }
  if (candidate.deterministicValidation && candidate.source !== 'DETERMINISTIC') {
    throw new Error('DLP_DETERMINISTIC_VALIDATION_SOURCE_INVALID');
  }
}

function compareCandidates(left: DlpEntityCandidate, right: DlpEntityCandidate): number {
  if (left.deterministicValidation !== right.deterministicValidation) {
    return left.deterministicValidation ? -1 : 1;
  }
  const sourceDifference = SOURCE_PRIORITY[right.source] - SOURCE_PRIORITY[left.source];
  if (sourceDifference !== 0) return sourceDifference;
  if (left.confidence !== right.confidence) return right.confidence - left.confidence;
  const lengthDifference = (right.end - right.start) - (left.end - left.start);
  if (lengthDifference !== 0) return lengthDifference;
  return `${left.recognizerId}@${left.recognizerVersion}`.localeCompare(
    `${right.recognizerId}@${right.recognizerVersion}`,
  );
}

function overlaps(left: DlpEntityCandidate, right: DlpEntityCandidate): boolean {
  return left.start < right.end && right.start < left.end;
}

function candidateIdentity(candidate: DlpEntityCandidate): string {
  return `${candidate.source}:${candidate.recognizerId}@${candidate.recognizerVersion}`;
}

export function presidioCandidatesToDlpEntities(
  candidates: readonly PresidioEntityCandidate[],
): readonly DlpEntityCandidate[] {
  return candidates.map((candidate) => ({
    entityType: candidate.entityType,
    start: candidate.start,
    end: candidate.end,
    confidence: candidate.score,
    recognizerId: candidate.recognizerId ?? 'presidio-analyzer',
    recognizerVersion: candidate.recognizerVersion,
    source: 'PRESIDIO_SHADOW',
    deterministicValidation: false,
  }));
}

export function observationsToDlpEntities(
  observations: readonly Observation[],
): readonly DlpEntityCandidate[] {
  return observations.flatMap((observation) => observation.evidence.flatMap((evidence) => {
    if (evidence.start === undefined || evidence.end === undefined) return [];
    return [{
      entityType: observation.riskType,
      start: evidence.start,
      end: evidence.end,
      confidence: observation.score,
      recognizerId: observation.detectorId,
      recognizerVersion: observation.detectorVersion,
      source: 'DETERMINISTIC' as const,
      deterministicValidation: true,
      contentHmac: evidence.contentHmac,
    }];
  }));
}

export function fuseDlpEntities(
  candidates: readonly DlpEntityCandidate[],
  options: DlpFusionOptions,
): DlpFusionResult {
  const maximumCandidates = options.maximumCandidates ?? 10_000;
  if (!Number.isSafeInteger(maximumCandidates) || maximumCandidates <= 0) {
    throw new Error('DLP_MAXIMUM_CANDIDATES_INVALID');
  }
  if (candidates.length > maximumCandidates) throw new Error('DLP_CANDIDATE_CAPACITY_EXCEEDED');
  candidates.forEach(validateCandidate);

  const remaining = [...candidates].sort((left, right) =>
    left.start - right.start || left.end - right.end || compareCandidates(left, right));
  const resolved: FusedDlpEntity[] = [];
  while (remaining.length > 0) {
    const first = remaining.shift();
    if (!first) break;
    const conflictGroup = [first];
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const candidate = remaining[index];
      if (conflictGroup.some((member) => overlaps(member, candidate))) {
        conflictGroup.push(candidate);
        remaining.splice(index, 1);
      }
    }
    conflictGroup.sort(compareCandidates);
    const winner = conflictGroup[0];
    const corroboratedBy = conflictGroup
      .filter((candidate) => candidate.entityType === winner.entityType)
      .map(candidateIdentity);
    const conflictingRecognizers = conflictGroup
      .filter((candidate) => candidate.entityType !== winner.entityType)
      .map(candidateIdentity);
    resolved.push({
      ...winner,
      action: options.actionByEntityType[winner.entityType] ?? options.defaultAction,
      corroboratedBy: [...new Set(corroboratedBy)].sort(),
      conflictingRecognizers: [...new Set(conflictingRecognizers)].sort(),
    });
  }

  return {
    entities: resolved.sort((left, right) => left.start - right.start || left.end - right.end),
    degradationEvidence: options.presidioAvailable ? [] : ['DLP_PRESIDIO_SIDECAR_UNAVAILABLE'],
  };
}
