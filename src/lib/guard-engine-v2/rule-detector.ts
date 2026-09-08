import { assessRuleMatch } from './rule-constraints';
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
    // 截断到与内置检测器一致的上限：超限不应转化为拦截
    return safeRegexMatches(view.text, rule.pattern, rule.caseSensitive).slice(0, 100);
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

function matchWithinException(
  match: Pick<LexicalMatch, 'raw' | 'index'>,
  exceptionMatches: readonly { raw: string; index: number }[],
): boolean {
  const matchEnd = match.index + match.raw.length;
  return exceptionMatches.some((exceptionMatch) =>
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
    let diagnosticCount = 0;
    const evaluationTime = this.now();
    // Signed literal hard denies also apply to the exact assembled text, without cross-source decoding.
    // Every hit keeps all intersecting parent envelopes; ordinary rules remain source-local.
    const text=context.request.content.text??'';
    const assembled:NormalizedView|undefined=context.envelopes.length>1&&this.rules.some(rule=>rule.mandatoryDeny)?{
      id:'assembled_original',text,originSpans:Array.from({length:text.length},(_,index)=>({start:index,end:index+1})),transforms:[],confidence:1,depth:0,
    }:undefined;
    const views=assembled?[...context.views,assembled]:context.views;
    // 每个（例外, 视图）的出现位置只计算一次：
    // 此前在每条规则×每条匹配上全量重扫例外文本，规则/例外/视图一多是平方级开销
    const exceptionOccurrences = new Map<
      RuleExceptionSpec,
      Map<string, readonly { raw: string; index: number }[]>
    >();
    const occurrencesFor = (
      view: NormalizedView,
      exception: RuleExceptionSpec,
    ): readonly { raw: string; index: number }[] => {
      let perView = exceptionOccurrences.get(exception);
      if (!perView) {
        perView = new Map();
        exceptionOccurrences.set(exception, perView);
      }
      let occurrences = perView.get(view.id);
      if (!occurrences) {
        occurrences = simpleOccurrences(view, exception);
        perView.set(view.id, occurrences);
      }
      return occurrences;
    };
    const retain = (view: NormalizedView, rule: RuleSpec, start: number, end: number): boolean => {
      if (view.id==='assembled_original'&&!rule.mandatoryDeny) return false;
      if (!ruleIsActiveForRequest(rule,context,evaluationTime)) return false;
      const origin = mapViewRange(view,start,end);
      const sourceScope = context.envelopes.find(e => e.contentStart <= origin.start && e.contentEnd >= origin.end);
      const constraints = assessRuleMatch(view.text,{start,end},rule.matchConstraints,rule.caseSensitive);
      if (!constraints.matched || constraints.evidence.some(range => {
        const mapped = mapViewRange(view,range.start,range.end);
        return context.envelopes.length > 0 && (!sourceScope || mapped.start < sourceScope.contentStart || mapped.end > sourceScope.contentEnd);
      })) return false;
      if (!rule.mandatoryDeny && this.exceptions.some(exception =>
        exception.targetRuleIds?.includes(rule.id) && exceptionAppliesToRisk(exception,rule) &&
        exceptionIsActiveForRequest(exception,context,evaluationTime) &&
        matchWithinException({raw:view.text.slice(start,end),index:start},occurrencesFor(view,exception)))) return false;
      const classification = classifyContextRole(context.request.content.text ?? '',origin,
        sourceScope ? {start:sourceScope.contentStart,end:sourceScope.contentEnd} : undefined);
      if (!rule.mandatoryDeny && (this.decisionPolicyVersion === 1 || rule.matchConstraints?.contextPolicy === 'LOCAL_INTENT_V1') &&
          (context.envelopes.length === 0 || sourceScope) &&
          (CONTEXTUAL_RISK_TYPES.has(rule.riskType) || rule.matchConstraints?.contextPolicy === 'LOCAL_INTENT_V1') &&
          classification.suppressLexicalBlock) {
        if (diagnosticCount++ < 128) observations.push({
          detectorId:this.id,detectorVersion:this.version,riskType:rule.riskType,ruleId:rule.id,ruleVersion:rule.ruleVersion,
          status:'SKIPPED',decisionRole:'CLEARED',contextRole:classification.role,score:0,severity:'NONE',scoreMeaning:'POLICY',
          reasonCode:'CONTEXT_SUPPRESSED_OCCURRENCE',evidence:[textEvidence(context,view,start,end,view.text.slice(start,end),'[语境抑制]')],
        });
        return false;
      }
      return true;
    };
    const lexicalMatches = new Map(views.map(view =>
      [view.id,this.matcher.find(view,(rule,start,end)=>retain(view,rule,start,end))]));
    for (const rule of this.ordered) {
      if (context.signal.aborted) throw context.signal.reason;
      if (!ruleIsActiveForRequest(rule, context, evaluationTime)) continue;
      const isExcepted = !rule.mandatoryDeny && this.exceptions.some((exception) => {
        const isLegacyDimensionException = exception.targetRuleIds === undefined;
        return this.decisionPolicyVersion === 1 && isLegacyDimensionException &&
          exceptionAppliesToRisk(exception, rule) &&
          exceptionIsActiveForRequest(exception, context, evaluationTime) &&
          context.views.some((view) => occurrencesFor(view, exception).length > 0);
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
      const evidenceRanges = new Set<string>();
      const roles = new Set<ContextRole>();
      let strongestViewConfidence = 0;
      let approximate = false;
      for (const view of views) {
        if(view.id==='assembled_original'&&!rule.mandatoryDeny)continue;
        const modes = rule.matchConstraints?.normalizationModes;
        if (modes && !modes.includes((view.depth ?? 0) === 0 ? 'original' : (view.transforms?.at(-1)?.method ?? view.id))) continue;
        const viewMatches = rule.matchType === 'regex'
          ? safeRegexMatches(view.text,rule.pattern,rule.caseSensitive,match => retain(view,rule,match.index,match.index+match.raw.length)).slice(0,100).map((match): LexicalMatch => ({
              ruleId: rule.id,
              ...match,
              approximate: false,
            }))
          : lexicalMatches.get(view.id)?.get(rule.id) ?? [];
        for (const match of viewMatches) {
          const constraint = assessRuleMatch(view.text,{start:match.index,end:match.index+match.raw.length},rule.matchConstraints,rule.caseSensitive);
          if (!constraint.matched) continue;
          if (targetedExceptions.some((exception) =>
            matchWithinException(match, occurrencesFor(view, exception)))) continue;
          const origin = mapViewRange(view, match.index, match.index + match.raw.length);
          const sourceScope = context.envelopes.find(envelope => envelope.contentStart <= origin.start && envelope.contentEnd >= origin.end);
          if (constraint.evidence.some(range => {
            const atomOrigin=mapViewRange(view,range.start,range.end);
            return context.envelopes.length > 0 && (!sourceScope || atomOrigin.start < sourceScope.contentStart || atomOrigin.end > sourceScope.contentEnd);
          })) continue;
          const contextRole = classifyContextRole(
            context.request.content.text ?? '',
            origin,
            sourceScope ? { start: sourceScope.contentStart, end: sourceScope.contentEnd } : undefined,
          );
          if (
            !rule.mandatoryDeny &&
            (this.decisionPolicyVersion === 1 || rule.matchConstraints?.contextPolicy === 'LOCAL_INTENT_V1') &&
            (context.envelopes.length === 0 || sourceScope !== undefined) &&
            (CONTEXTUAL_RISK_TYPES.has(rule.riskType) || rule.matchConstraints?.contextPolicy === 'LOCAL_INTENT_V1') &&
            contextRole.suppressLexicalBlock
          ) {
            if (diagnosticCount < 128) {
              observations.push({ detectorId: this.id, detectorVersion: this.version, riskType: rule.riskType,
                ruleId: rule.id, ruleVersion: rule.ruleVersion, status: 'SKIPPED', decisionRole: 'CLEARED',
                contextRole: contextRole.role, score: 0, severity: 'NONE', scoreMeaning: 'POLICY',
                reasonCode: 'CONTEXT_SUPPRESSED_OCCURRENCE',
                evidence: [textEvidence(context, view, match.index, match.index + match.raw.length, match.raw, '[语境抑制]')] });
              diagnosticCount++;
            }
            continue;
          }
          const rootKey = String(origin.start) + ':' + String(origin.end);
          if (evidenceRanges.has(rootKey)) continue;
          evidenceRanges.add(rootKey);
          roles.add(contextRole.role);
          approximate ||= match.approximate;
          strongestViewConfidence = Math.max(strongestViewConfidence, view.confidence ?? 1);
          if (evidence.length >= 100) break; // 证据条数封顶：截断只影响证据数量，不改变判定
          for (const atom of constraint.evidence) {
            if (evidence.length < 99) evidence.push(textEvidence(context,view,atom.start,atom.end,view.text.slice(atom.start,atom.end),'[关系证据]'));
          }
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
        ...(rule.matchConstraints?.evidenceClass || this.decisionPolicyVersion === 2 ? {
          decisionRole: rule.mandatoryDeny ? 'HARD_DENY' as const
            : rule.matchConstraints?.evidenceClass === 'DETERMINISTIC_RISK' ? 'CONFIRMED_RISK' as const : 'CANDIDATE' as const,
        } : {}),
        riskType: rule.riskType,
        category: rule.riskType,
        confidence: score,
        scoreMeaning: 'POLICY',
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
