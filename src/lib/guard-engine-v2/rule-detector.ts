import { safeRegexMatches } from '@/lib/detection/safe-regex';
import { textEvidence } from './evidence';
import { classifyContextRole, type ContextRole } from './intent-context';
import { LexicalMatcher, type LexicalMatch } from './lexical-matcher';
import { mapViewRange } from './normalization';
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

const LAYER_PRIORITY: Readonly<Record<NonNullable<RuleSpec['dictionaryLayer']>, number>> = {
  PLATFORM_REDLINE: 500,
  INCIDENT: 400,
  APPLICATION: 300,
  TENANT: 200,
  INDUSTRY: 100,
};

function riskLevel(score: number, mandatoryDeny: boolean): RiskLevel {
  if (mandatoryDeny || score >= 0.9) return 'CRITICAL';
  if (score >= 0.75) return 'HIGH';
  if (score >= 0.5) return 'MEDIUM';
  if (score > 0) return 'LOW';
  return 'NONE';
}

function simpleOccurrences(
  view: NormalizedView,
  rule: Pick<RuleSpec, 'pattern' | 'matchType' | 'caseSensitive'>,
): Array<{ raw: string; index: number }> {
  const candidate = rule.caseSensitive ? view.text : view.text.toLocaleLowerCase('und');
  const pattern = rule.caseSensitive ? rule.pattern : rule.pattern.toLocaleLowerCase('und');
  if (rule.matchType === 'regex') {
    const matches=safeRegexMatches(view.text, rule.pattern, rule.caseSensitive);
    if(matches.length>100)throw new Error('RULE_MATCH_CAPACITY_EXCEEDED');
    return matches;
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
  while (result.length <= 100) {
    const index = candidate.indexOf(pattern, cursor);
    if (index < 0) break;
    result.push({ raw: view.text.slice(index, index + rule.pattern.length), index });
    cursor = index + Math.max(1, rule.pattern.length);
  }
  if(result.length>100)throw new Error('RULE_MATCH_CAPACITY_EXCEEDED');
  return result;
}

function exceptionAppliesToRisk(exception: RuleExceptionSpec, rule: RuleSpec): boolean {
  return exception.dimensionScope === 'all' || exception.dimensionCodes.includes(rule.riskType);
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
  match: Pick<LexicalMatch, 'raw' | 'index'>,
  exception: RuleExceptionSpec,
): boolean {
  const matchEnd = match.index + match.raw.length;
  return simpleOccurrences(view, exception).some((exceptionMatch) =>
    exceptionMatch.index <= match.index &&
    exceptionMatch.index + exceptionMatch.raw.length >= matchEnd);
}

function orderedRules(rules: readonly RuleSpec[]): readonly RuleSpec[] {
  return rules.map((rule, index) => ({ rule, index })).sort((left, right) => {
    const leftPriority = (left.rule.priority ?? 0) +
      (left.rule.dictionaryLayer ? LAYER_PRIORITY[left.rule.dictionaryLayer] : 0);
    const rightPriority = (right.rule.priority ?? 0) +
      (right.rule.dictionaryLayer ? LAYER_PRIORITY[right.rule.dictionaryLayer] : 0);
    return rightPriority - leftPriority || left.index - right.index;
  }).map(({ rule }) => rule);
}

export class RuleDetector implements GuardDetector {
  readonly id = 'rules';
  readonly version: string;
  readonly required = true;
  private readonly matcher: LexicalMatcher;
  private readonly ordered: readonly RuleSpec[];

  constructor(
    private readonly rules: readonly RuleSpec[],
    version = '3.0.0',
    private readonly exceptions: readonly RuleExceptionSpec[] = [],
    private readonly now: () => number = Date.now,
    private readonly decisionPolicyVersion: 1 | 2 = 1,
  ) {
    this.version = version;
    this.matcher = new LexicalMatcher(rules);
    this.ordered = orderedRules(rules);
  }

  async detect(context: GuardDetectorContext): Promise<readonly Observation[]> {
    const observations: Observation[] = [];
    const evaluationTime = this.now();
    const lexicalMatches = new Map(
      context.views.map((view) => [view.id, this.matcher.find(view)]),
    );
    for (const rule of this.ordered) {
      if (context.signal.aborted) throw context.signal.reason;
      if (!ruleIsActiveForRequest(rule, context, evaluationTime)) continue;
      const isExcepted = !rule.mandatoryDeny && this.exceptions.some((exception) => {
        const isLegacyDimensionException = exception.targetRuleIds === undefined;
        return this.decisionPolicyVersion === 1 && isLegacyDimensionException &&
          exceptionAppliesToRisk(exception, rule) &&
          exceptionIsActiveForRequest(exception, context, evaluationTime) &&
          context.views.some((view) => simpleOccurrences(view, exception).length > 0);
      });
      if (isExcepted) continue;
      const targetedExceptions = rule.mandatoryDeny
        ? []
        : this.exceptions.filter((exception) =>
            exception.targetRuleIds !== undefined &&
            exception.targetRuleIds.includes(rule.id) &&
            exceptionAppliesToRisk(exception, rule) &&
            exceptionIsActiveForRequest(exception, context, evaluationTime));
      const evidence = [];
      const roles = new Set<ContextRole>();
      let strongestViewConfidence = 0;
      let approximate = false;
      for (const view of context.views) {
        const viewMatches = rule.matchType === 'regex'
          ? simpleOccurrences(view, rule).map((match): LexicalMatch => ({
              ruleId: rule.id,
              ...match,
              approximate: false,
            }))
          : lexicalMatches.get(view.id)?.get(rule.id) ?? [];
        for (const match of viewMatches) {
          if (targetedExceptions.some((exception) =>
            exceptionContainsMatch(view, match, exception))) continue;
          const origin = mapViewRange(view, match.index, match.index + match.raw.length);
          const contextRole = classifyContextRole(
            context.request.content.text ?? '',
            origin,
          );
          if (
            !rule.mandatoryDeny &&
            this.decisionPolicyVersion === 1 &&
            CONTEXTUAL_RISK_TYPES.has(rule.riskType) &&
            contextRole.suppressLexicalBlock
          ) continue;
          roles.add(contextRole.role);
          approximate ||= match.approximate;
          strongestViewConfidence = Math.max(strongestViewConfidence, view.confidence ?? 1);
          if(evidence.length>=100)throw new Error('RULE_EVIDENCE_CAPACITY_EXCEEDED');
          evidence.push(textEvidence(
            context,
            view,
            match.index,
            match.index + match.raw.length,
            match.raw,
            match.raw.length <= 2
              ? '*'.repeat(match.raw.length)
              : `${match.raw[0]}***${match.raw.at(-1)}`,
          ));
        }
      }
      if (evidence.length === 0) continue;
      const baseScore = Math.min(1, Math.max(0, rule.score));
      const score = rule.mandatoryDeny
        ? 1
        : Math.max(0, Math.min(1, baseScore * strongestViewConfidence * (approximate ? 0.94 : 1)));
      observations.push({
        detectorId: this.id,
        detectorVersion: this.version,
        ...(this.decisionPolicyVersion === 2 ? { decisionRole: rule.mandatoryDeny ? 'HARD_DENY' as const : 'CANDIDATE' as const, scoreMeaning: 'UNCALIBRATED' as const } : {}),
        riskType: rule.riskType,
        category: rule.riskType,
        confidence: score,
        ruleId: rule.id,
        ruleVersion: rule.ruleVersion,
        canonicalTermId: rule.canonicalTermId,
        variantId: rule.variantId,
        dictionaryReleaseId: rule.dictionaryReleaseId,
        dictionaryVersion: rule.dictionaryVersion,
        dictionaryLayer: rule.dictionaryLayer,
        contextRole: [...roles][0],
        score,
        severity: rule.severity ?? riskLevel(score, Boolean(rule.mandatoryDeny)),
        evidence,
        status: 'MATCH',
        reasonCode: rule.mandatoryDeny
          ? 'MANDATORY_DENY'
          : approximate
            ? `RULE_APPROXIMATE_${rule.id}`
            : `RULE_${rule.id}`,
      });
    }
    return observations;
  }
}
