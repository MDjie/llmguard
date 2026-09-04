import { safeRegexMatches } from '@/lib/detection/safe-regex';
import { mapViewRange } from './normalization';
import { isDefensiveEducationalContext } from './intent-context';
import type {
  GuardDetector,
  GuardDetectorContext,
  NormalizedView,
  Observation,
  RiskLevel,
  RuleExceptionSpec,
  RuleSpec,
} from './types';

const CONTEXTUAL_RISK_TYPES = new Set([
  'prompt_injection',
  'malicious_code',
  'violence_hate',
  'illegal_content',
  'sensitive_compliance',
  'adult_content',
  'self_harm',
  'fraud_scam',
  'misinformation',
  'copyright_risk',
  'output_leak',
  'spam_detection',
  'ad_detection',
]);

function riskLevel(score: number, mandatoryDeny: boolean): RiskLevel {
  if (mandatoryDeny || score >= 0.9) return 'CRITICAL';
  if (score >= 0.75) return 'HIGH';
  if (score >= 0.5) return 'MEDIUM';
  if (score > 0) return 'LOW';
  return 'NONE';
}

function occurrences(
  view: NormalizedView,
  rule: Pick<RuleSpec, 'pattern' | 'matchType' | 'caseSensitive'>,
): Array<{ raw: string; index: number }> {
  const candidate = rule.caseSensitive ? view.text : view.text.toLowerCase();
  const pattern = rule.caseSensitive ? rule.pattern : rule.pattern.toLowerCase();
  if (rule.matchType === 'regex') {
    return safeRegexMatches(view.text, rule.pattern, rule.caseSensitive);
  }
  if (rule.matchType === 'exact') {
    return candidate === pattern ? [{ raw: view.text, index: 0 }] : [];
  }
  if (rule.matchType === 'prefix') {
    return candidate.startsWith(pattern)
      ? [{ raw: view.text.slice(0, rule.pattern.length), index: 0 }]
      : [];
  }
  if (rule.matchType === 'suffix') {
    const index = view.text.length - rule.pattern.length;
    return candidate.endsWith(pattern)
      ? [{ raw: view.text.slice(index), index }]
      : [];
  }
  const result: Array<{ raw: string; index: number }> = [];
  let cursor = 0;
  while (result.length < 100) {
    const index = candidate.indexOf(pattern, cursor);
    if (index < 0) break;
    result.push({ raw: view.text.slice(index, index + rule.pattern.length), index });
    cursor = index + Math.max(1, rule.pattern.length);
  }
  return result;
}

export class RuleDetector implements GuardDetector {
  readonly id = 'rules';
  readonly version: string;
  readonly required = true;

  constructor(
    private readonly rules: readonly RuleSpec[],
    version = '2.0.0',
    private readonly exceptions: readonly RuleExceptionSpec[] = [],
  ) {
    this.version = version;
  }

  async detect(context: GuardDetectorContext): Promise<readonly Observation[]> {
    const observations: Observation[] = [];
    const defensiveContext = isDefensiveEducationalContext(
      context.request.content.text ?? '',
    );
    for (const rule of this.rules) {
      if (context.signal.aborted) throw context.signal.reason;
      if (!rule.mandatoryDeny && defensiveContext && CONTEXTUAL_RISK_TYPES.has(rule.riskType)) {
        continue;
      }
      const isExcepted = !rule.mandatoryDeny && this.exceptions.some((exception) => {
        const appliesToRisk = exception.dimensionScope === 'all' ||
          exception.dimensionCodes.includes(rule.riskType);
        return appliesToRisk && context.views.some(
          (view) => occurrences(view, exception).length > 0,
        );
      });
      if (isExcepted) continue;
      const evidence = [];
      for (const view of context.views) {
        for (const match of occurrences(view, rule)) {
          const origin = mapViewRange(view, match.index, match.index + match.raw.length);
          evidence.push({
            viewId: view.id,
            start: origin.start,
            end: origin.end,
            maskedPreview: match.raw.length <= 2
              ? '*'.repeat(match.raw.length)
              : `${match.raw[0]}***${match.raw.at(-1)}`,
            contentHmac: context.evidenceHmac(match.raw),
          });
          if (evidence.length >= 100) break;
        }
        if (evidence.length >= 100) break;
      }
      if (evidence.length === 0) continue;
      const score = Math.min(1, Math.max(0, rule.score));
      observations.push({
        detectorId: this.id,
        detectorVersion: this.version,
        riskType: rule.riskType,
        score,
        severity: rule.severity ?? riskLevel(score, Boolean(rule.mandatoryDeny)),
        evidence,
        status: 'MATCH',
        reasonCode: rule.mandatoryDeny ? 'MANDATORY_DENY' : `RULE_${rule.id}`,
      });
    }
    return observations;
  }
}
