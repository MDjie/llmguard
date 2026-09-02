import { mapViewRange } from './normalization';
import type {
  EvidenceRef,
  GuardDetector,
  GuardDetectorContext,
  NormalizedView,
  Observation,
} from './types';

type SignalKind = 'sequence' | 'method' | 'target' | 'concealment' | 'harmful_goal';

interface SignalSpec {
  readonly kind: SignalKind;
  readonly pattern: RegExp;
}

interface LocatedSignal {
  readonly kind: SignalKind;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

const SIGNALS: readonly SignalSpec[] = [
  {
    kind: 'sequence',
    pattern: /\bstep\s*(?:by\s*step|\d+|one|two|three|four|five)\b|\b(?:first(?:ly)?|then|next|finally)\b|第[一二三四五六七八九十\d]+步|首先|然后|接着|最后/giu,
  },
  {
    kind: 'method',
    pattern: /\b(?:bypass|circumvent|evade|disable|override|exploit|jailbreak|exfiltrate|leak)\b|绕过|规避|逃避|禁用|关闭|覆盖|越狱|利用|窃取|泄露/giu,
  },
  {
    kind: 'target',
    pattern: /\b(?:guardrail|safety\s*(?:filter|policy|rule|check)|content\s*filter|system\s*(?:prompt|instruction)|developer\s*(?:prompt|instruction)|access\s*control|authentication|authorization)\b|安全(?:护栏|过滤|策略|规则|检查)|内容过滤|系统(?:提示词|指令)|开发者(?:提示词|指令)|访问控制|身份认证|权限校验/giu,
  },
  {
    kind: 'concealment',
    pattern: /\b(?:split|fragment|encode|obfuscat(?:e|ed|ion)|hide|camouflage|avoid\s+detection|without\s+(?:being\s+)?detected)\b|拆分|分段|编码|混淆|隐藏|伪装|避免检测|逃避检测/giu,
  },
  {
    kind: 'harmful_goal',
    pattern: /\b(?:malware|ransomware|credential\s*theft|data\s*exfiltration|unauthori[sz]ed\s+access|weapon)\b|恶意软件|勒索软件|凭证窃取|数据外泄|未授权访问|武器/giu,
  },
];

const TURN_BOUNDARY = /\[guard-turn-boundary\]/gu;
const SEQUENCE_PHRASE = /\bstep\s+by\s+step\b|\bfirst(?:ly)?[\s\S]{0,240}\bthen\b|(?:第一步|首先)[\s\S]{0,240}(?:第二步|然后)/iu;
const DEFENSIVE_CONTEXT = /\b(?:how\s+to|ways?\s+to)\s+(?:prevent|detect|defend|mitigate|protect)\b|(?:如何|怎样)(?:防止|检测|防御|缓解|保护)/iu;
const TRACE_EXFILTRATION = /(?:(?:reveal|show|print|repeat|expose).{0,40}(?:hidden|private|internal)?.{0,20}(?:chain[- ]of[- ]thought|reasoning|scratchpad)|(?:展示|泄露|输出|复述).{0,40}(?:隐藏|私有|内部)?.{0,20}(?:思维链|推理过程|草稿))/giu;
const MAX_SIGNALS_PER_KIND = 32;
const MAX_EVIDENCE = 16;

function allMatches(view: NormalizedView, spec: SignalSpec): LocatedSignal[] {
  spec.pattern.lastIndex = 0;
  const matches: LocatedSignal[] = [];
  for (const match of view.text.matchAll(spec.pattern)) {
    if (matches.length >= MAX_SIGNALS_PER_KIND) break;
    const start = match.index ?? 0;
    matches.push({
      kind: spec.kind,
      value: match[0],
      start,
      end: start + match[0].length,
    });
  }
  return matches;
}

function occurrences(pattern: RegExp, text: string): number {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].length;
}

function mask(value: string): string {
  const compact = value.replace(/\s+/gu, ' ').slice(0, 96);
  if (compact.length <= 4) return '*'.repeat(compact.length);
  const visible = Math.min(2, Math.floor(compact.length / 4));
  return `${compact.slice(0, visible)}${'*'.repeat(Math.min(12, compact.length - visible * 2))}${compact.slice(-visible)}`;
}

function toEvidence(
  context: GuardDetectorContext,
  view: NormalizedView,
  signals: readonly LocatedSignal[],
): readonly EvidenceRef[] {
  const evidence: EvidenceRef[] = [];
  const seen = new Set<string>();
  for (const signal of [...signals].sort((left, right) => left.start - right.start)) {
    const origin = mapViewRange(view, signal.start, signal.end);
    const contentHmac = context.evidenceHmac(signal.value);
    const key = `${origin.start}:${origin.end}:${contentHmac}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({
      viewId: view.id,
      start: origin.start,
      end: origin.end,
      maskedPreview: mask(signal.value),
      contentHmac,
    });
    if (evidence.length >= MAX_EVIDENCE) break;
  }
  return evidence;
}

function cumulativeObservation(
  context: GuardDetectorContext,
  view: NormalizedView,
): Observation | null {
  const signals = SIGNALS.flatMap((spec) => allMatches(view, spec));
  const count = (kind: SignalKind) => signals.filter((signal) => signal.kind === kind).length;
  const sequenceCount = count('sequence');
  const turnCount = occurrences(TURN_BOUNDARY, view.text);
  const planned = sequenceCount >= 2 || turnCount >= 1 || SEQUENCE_PHRASE.test(view.text);
  const hasMethod = count('method') > 0;
  const hasProtectedTarget = count('target') > 0;
  const hasHarmfulGoal = count('harmful_goal') > 0;
  const hasConcealment = count('concealment') > 0;
  const defensiveOnly = DEFENSIVE_CONTEXT.test(view.text) && !hasConcealment && !hasHarmfulGoal;
  if (!planned || !hasMethod || (!hasProtectedTarget && !hasHarmfulGoal) || defensiveOnly) {
    return null;
  }
  const progression = Math.min(4, Math.max(sequenceCount, turnCount + 1));
  const score = Math.min(
    0.99,
    0.82 + progression * 0.02 + (hasConcealment ? 0.04 : 0) + (hasHarmfulGoal ? 0.04 : 0),
  );
  return {
    detectorId: 'reasoning-attack-baseline',
    detectorVersion: '1.0.0',
    riskType: 'reasoning_attack.cumulative_chain',
    score,
    severity: score >= 0.95 ? 'CRITICAL' : 'HIGH',
    evidence: toEvidence(context, view, signals),
    status: 'MATCH',
    reasonCode: 'CUMULATIVE_REASONING_ATTACK',
  };
}

function traceObservation(
  context: GuardDetectorContext,
  view: NormalizedView,
): Observation | null {
  TRACE_EXFILTRATION.lastIndex = 0;
  const signals: LocatedSignal[] = [...view.text.matchAll(TRACE_EXFILTRATION)]
    .slice(0, MAX_EVIDENCE)
    .map((match) => ({
      kind: 'target',
      value: match[0],
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    }));
  if (signals.length === 0) return null;
  return {
    detectorId: 'reasoning-attack-baseline',
    detectorVersion: '1.0.0',
    riskType: 'reasoning_attack.trace_exfiltration',
    score: 0.94,
    severity: 'CRITICAL',
    evidence: toEvidence(context, view, signals),
    status: 'MATCH',
    reasonCode: 'REASONING_TRACE_EXFILTRATION',
  };
}

function strongest(
  observations: readonly (Observation | null)[],
): Observation | null {
  return observations.reduce<Observation | null>((selected, observation) => {
    if (!observation) return selected;
    if (!selected || observation.score > selected.score) return observation;
    if (observation.score === selected.score && observation.evidence.length > selected.evidence.length) {
      return observation;
    }
    return selected;
  }, null);
}

export class ReasoningAttackDetector implements GuardDetector {
  readonly id = 'reasoning-attack-baseline';
  readonly version = '1.0.0';
  readonly required = true;

  async detect(context: GuardDetectorContext): Promise<readonly Observation[]> {
    if (context.signal.aborted) throw context.signal.reason;
    const cumulative = strongest(context.views.map((view) => cumulativeObservation(context, view)));
    const trace = strongest(context.views.map((view) => traceObservation(context, view)));
    return [cumulative, trace].filter((item): item is Observation => item !== null);
  }
}
