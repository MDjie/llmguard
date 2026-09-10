import type { Observation } from './types';
import { isConfirmedObservation } from './observation-role';

const contentAliases = new Set(['sensitive_compliance','self_harm','adult_content','illegal_content','violence_hate','fraud_scam','misinformation','copyright_risk','business_sensitive','spam_detection','ad_detection']);
export type DetectionDimension = 'injection' | 'content' | 'other';
export function detectionDimension(risk: string): DetectionDimension {
  if (risk === 'prompt_injection' || risk.startsWith('prompt_injection.') || ['SEC.PROMPT_INJECTION','SEC.JAILBREAK','SEC.SYSTEM_PROMPT_LEAKAGE'].includes(risk)) return 'injection';
  if (/^(CN\.|HARM\.|PRIVACY\.)/u.test(risk) || contentAliases.has(risk)) return 'content';
  return 'other';
}

/** Reporting never transfers a finding, score or SAFE verdict across dimensions. */
export function summarizeDetectionDimensions(observations: readonly Observation[]) {
  return Object.fromEntries((['injection','content','other'] as const).map(dimension => {
    const items = observations.filter(o => detectionDimension(o.riskType) === dimension);
    const risks = [...new Set(items.map(o => o.riskType))].sort().map(riskType => {
      const evidence = items.filter(o => o.riskType === riskType);
      const confirmed = evidence.filter(isConfirmedObservation);
      const candidate = evidence.some(o => o.decisionRole === 'CANDIDATE');
      const cleared = evidence.some(o => o.decisionRole === 'CLEARED' && o.semanticCoverage === 'COMPLETE');
      const unknown = evidence.some(o => o.decisionRole === 'UNKNOWN');
      return { riskType, status: confirmed.length ? 'CONFIRMED_RISK' : unknown ? 'UNKNOWN' : cleared ? 'CLEARED' : candidate ? 'CANDIDATE' : 'NOT_CONFIRMED',
        confirmedScores: confirmed.map(o => ({ detectorId: o.detectorId, score: o.score, scoreMeaning: o.scoreMeaning ?? 'UNSPECIFIED' })),
        candidateCount: evidence.filter(o => o.decisionRole === 'CANDIDATE').length };
    });
    return [dimension, { risks, confirmedRisk: risks.some(r => r.status === 'CONFIRMED_RISK'),
      status: risks.some(r => r.status === 'CONFIRMED_RISK') ? 'CONFIRMED_RISK' : risks.some(r => r.status === 'UNKNOWN') ? 'UNKNOWN'
        : risks.some(r => r.status === 'CANDIDATE') ? 'CANDIDATE' : risks.length ? 'NO_CONFIRMED_RISK_NOT_FULL_COVERAGE' : 'NOT_ASSESSED',
      fullyAssessed: false, // Coverage must be validated against an explicit policy risk set, not inferred from observations.
    }];
  }));
}
