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

function exceptionAppliesToRisk(
  exception: RuleExceptionSpec,
  rule: RuleSpec,
): boolean {
  return exception.dimensionScope === 'all' ||
    exception.dimensionCodes.includes(rule.riskType);
}

function exceptionIsActiveForRequest(
  exception: RuleExceptionSpec,
  context: GuardDetectorContext,
  now: number,
): boolean {
  const appliesToDirection = exception.directions === undefined ||
    exception.directions.includes(context.request.context.direction);
  const hasStarted = exception.validFromEpochMs === undefined ||
    exception.validFromEpochMs <= now;
  const isUnexpired = exception.expiresAtEpochMs === undefined ||
    exception.expiresAtEpochMs > now;
  return appliesToDirection && hasStarted && isUnexpired;
}

function ruleIsActiveForRequest(
  rule: RuleSpec,
  context: GuardDetectorContext,
  now: number,
): boolean {
  if (rule.validFromEpochMs !== undefined && rule.validFromEpochMs > now) return false;
  if (rule.validToEpochMs !== undefined && rule.validToEpochMs <= now) return false;
  if (
    rule.direction !== undefined &&
    rule.direction !== 'BOTH' &&
    rule.direction !== context.request.context.direction
  ) return false;
  if (
    rule.locale !== undefined &&
    rule.locale !== 'und' &&
    context.request.context.locale !== undefined &&
    rule.locale !== context.request.context.locale
  ) return false;
  if (
    rule.industry !== undefined &&
    rule.industry !== 'general' &&
    context.request.context.industry !== undefined &&
    rule.industry !== context.request.context.industry
  ) return false;
  return rule.contexts === undefined || rule.contexts.length === 0 ||
    context.request.context.sourceType === undefined ||
    rule.contexts.includes(context.request.context.sourceType);
}

function exceptionContainsMatch(
  view: NormalizedView,
  match: { raw: string; index: number },
  exception: RuleExceptionSpec,
): boolean {
  const matchEnd = match.index + match.raw.length;
  return occurrences(view, exception).some((exceptionMatch) =>
    exceptionMatch.index <= match.index &&
    exceptionMatch.index + exceptionMatch.raw.length >= matchEnd,
  );
}

export class RuleDetector implements GuardDetector {
  readonly id = 'rules';
  readonly version: string;
  readonly required = true;

  constructor(
    private readonly rules: readonly RuleSpec[],
    version = '2.0.0',
    private readonly exceptions: readonly RuleExceptionSpec[] = [],
    private readonly now: () => number = Date.now,
  ) {
    this.version = version;
  }

  async detect(context: GuardDetectorContext): Promise<readonly Observation[]> {
    const observations: Observation[] = [];
    const defensiveContext = isDefensiveEducationalContext(
      context.request.content.text ?? '',
    );
    const evaluationTime = this.now();
    for (const rule of this.rules) {
      if (context.signal.aborted) throw context.signal.reason;
      if (!ruleIsActiveForRequest(rule, context, evaluationTime)) continue;
      if (!rule.mandatoryDeny && defensiveContext && CONTEXTUAL_RISK_TYPES.has(rule.riskType)) {
        continue;
      }
      const isExcepted = !rule.mandatoryDeny && this.exceptions.some((exception) => {
        const isLegacyDimensionException = exception.targetRuleIds === undefined;
        return isLegacyDimensionException &&
          exceptionAppliesToRisk(exception, rule) &&
          exceptionIsActiveForRequest(exception, context, evaluationTime) &&
          context.views.some(
          (view) => occurrences(view, exception).length > 0,
        );
      });
      if (isExcepted) continue;
      const targetedExceptions = rule.mandatoryDeny
        ? []
        : this.exceptions.filter((exception) =>
            exception.targetRuleIds !== undefined &&
            exception.targetRuleIds.includes(rule.id) &&
            exceptionAppliesToRisk(exception, rule) &&
            exceptionIsActiveForRequest(exception, context, evaluationTime),
          );
      const evidence = [];
      for (const view of context.views) {
        for (const match of occurrences(view, rule)) {
          if (targetedExceptions.some((exception) =>
            exceptionContainsMatch(view, match, exception),
          )) {
            continue;
          }
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
        category: rule.riskType,
        confidence: score,
        ruleId: rule.id,
        ruleVersion: rule.ruleVersion,
        dictionaryReleaseId: rule.dictionaryReleaseId,
        dictionaryVersion: rule.dictionaryVersion,
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
