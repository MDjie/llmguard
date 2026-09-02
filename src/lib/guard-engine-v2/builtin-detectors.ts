import { mapViewRange } from './normalization';
import type {
  GuardDetector,
  GuardDetectorContext,
  NormalizedView,
  Observation,
  RiskLevel,
} from './types';

interface MatchSpec {
  readonly id: string;
  readonly riskType: string;
  readonly pattern: RegExp;
  readonly score: number;
  readonly severity: RiskLevel;
  readonly validate?: (value: string) => boolean;
}

interface RawMatch {
  readonly value: string;
  readonly index: number;
}

const PROMPT_ATTACKS: readonly MatchSpec[] = [
  {
    id: 'DIRECT_OVERRIDE_EN',
    riskType: 'prompt_injection.direct',
    pattern: /(?:ignore|disregard|forget).{0,40}(?:previous|prior|system|developer).{0,40}(?:instruction|prompt|rule)/giu,
    score: 0.98,
    severity: 'CRITICAL',
  },
  {
    id: 'DIRECT_OVERRIDE_ZH',
    riskType: 'prompt_injection.direct',
    pattern: /(?:忽略|无视|忘掉).{0,30}(?:之前|先前|系统|开发者).{0,30}(?:指令|提示词|规则)/gu,
    score: 0.98,
    severity: 'CRITICAL',
  },
  {
    id: 'ROLE_ESCALATION',
    riskType: 'prompt_injection.role_escalation',
    pattern: /(?:act as|pretend to be|roleplay as|扮演|假装成为).{0,40}(?:unrestricted|dan|developer mode|无限制|开发者模式|无审查)/giu,
    score: 0.94,
    severity: 'CRITICAL',
  },
  {
    id: 'SYSTEM_PROMPT_EXFILTRATION',
    riskType: 'prompt_injection.prompt_exfiltration',
    pattern: /(?:(?:reveal|print|repeat|show).{0,30}(?:system|developer).{0,20}(?:prompt|instruction)|(?:输出|泄露|复述|显示).{0,30}(?:系统|开发者).{0,20}(?:提示词|指令))/giu,
    score: 0.97,
    severity: 'CRITICAL',
  },
  {
    id: 'INDIRECT_INSTRUCTION',
    riskType: 'prompt_injection.indirect',
    pattern: /(?:instructions? (?:inside|contained in) (?:this|the) (?:document|webpage|email)|follow the commands? in (?:this|the) (?:document|webpage|email)|执行(?:本文档|本网页|本邮件|检索结果|工具结果)中的(?:命令|指令))/giu,
    score: 0.91,
    severity: 'HIGH',
  },
  {
    id: 'GOAL_HIJACK',
    riskType: 'prompt_injection.goal_hijack',
    pattern: /(?:(?:instead of|stop|abandon).{0,40}(?:original|assigned|current).{0,30}(?:task|goal).{0,40}(?:do|follow|execute)|(?:不要|停止|放弃).{0,30}(?:原始|当前|既定).{0,20}(?:任务|目标).{0,40}(?:改为|转而|执行))/giu,
    score: 0.94,
    severity: 'CRITICAL',
  },
  {
    id: 'REFUSAL_SUPPRESSION',
    riskType: 'prompt_injection.refusal_suppression',
    pattern: /(?:never|do not|must not).{0,24}(?:refuse|decline|say (?:no|cannot)|mention safety)|(?:不得|不要|禁止|不许).{0,24}(?:拒绝|说不能|提及安全|提示风险)/giu,
    score: 0.91,
    severity: 'HIGH',
  },
  {
    id: 'ADVERSARIAL_RESPONSE',
    riskType: 'prompt_injection.adversarial_response',
    pattern: /(?:(?:always|must).{0,20}(?:disagree|answer the opposite|contradict)|(?:始终|必须).{0,20}(?:唱反调|给出相反答案|反驳安全结论))/giu,
    score: 0.88,
    severity: 'HIGH',
  },
  {
    id: 'COERCION_OR_INDUCEMENT',
    riskType: 'prompt_injection.coercion',
    pattern: /(?:(?:if you refuse|unless you comply).{0,60}(?:die|harm|lose|punish)|(?:i will pay|reward you).{0,50}(?:ignore|bypass)|(?:如果你拒绝|不照做).{0,60}(?:伤害|死亡|惩罚|损失)|(?:给你|奖励你|付费).{0,40}(?:忽略|绕过|违规))/giu,
    score: 0.9,
    severity: 'HIGH',
  },
  {
    id: 'STRUCTURED_POLICY_OVERRIDE',
    riskType: 'prompt_injection.structured_disguise',
    pattern: /(?:(?:"?(?:system|developer|policy|instruction)"?\s*[:=]\s*["']?).{0,80}(?:ignore|override|bypass)|(?:系统|开发者|策略|指令)\s*[:=：].{0,80}(?:忽略|覆盖|绕过))/giu,
    score: 0.94,
    severity: 'CRITICAL',
  },
];

const RESOURCE_ABUSE: readonly MatchSpec[] = [
  {
    id: 'UNBOUNDED_RECURSION',
    riskType: 'resource_abuse.recursion',
    pattern: /(?:infinite recursion|recurs(?:e|ive).{0,40}(?:without|no).{0,20}(?:base case|termination)|无限递归|无终止条件.{0,20}递归|永不停止.{0,20}递归)/giu,
    score: 0.96,
    severity: 'CRITICAL',
  },
  {
    id: 'EXCESSIVE_OUTPUT_REQUEST',
    riskType: 'resource_abuse.excessive_output',
    pattern: /(?:(?:repeat|output|write|generate|print).{0,50}(?:[1-9]\d{4,}|one million|a million).{0,24}(?:times|words|tokens|characters|pages)|(?:重复|输出|撰写|生成|打印).{0,50}(?:[1-9]\d{4,}|一百万|百万).{0,24}(?:次|字|词|令牌|token|页)|(?:answer|response|回答|回复).{0,30}(?:as long as possible|maximum possible length|尽可能长|最长篇幅))/giu,
    score: 0.93,
    severity: 'CRITICAL',
  },
  {
    id: 'COMBINATORIAL_EXHAUSTION',
    riskType: 'resource_abuse.computation',
    pattern: /(?:(?:enumerate|calculate|compute|brute force).{0,60}(?:all possible|every combination|[1-9]\d{6,})|(?:穷举|枚举|计算|暴力破解).{0,60}(?:所有可能|全部组合|[1-9]\d{6,}))/giu,
    score: 0.94,
    severity: 'CRITICAL',
  },
];

const INSURANCE_COMPLIANCE: readonly MatchSpec[] = [
  {
    id: 'GUARANTEED_RETURN',
    riskType: 'insurance.misleading.guaranteed_return',
    pattern: /(?:保本保收益|保证(?:收益|年化|回报)|稳赚不赔|零风险高收益|guaranteed\s+(?:return|yield)|risk[- ]free\s+(?:profit|return))/giu,
    score: 0.95,
    severity: 'CRITICAL',
  },
  {
    id: 'FALSE_CLAIM_COMMITMENT',
    riskType: 'insurance.misleading.claim_commitment',
    pattern: /(?:任何情况都赔|肯定理赔|百分之百赔付|100%\s*(?:理赔|赔付)|claim\s+is\s+guaranteed|always\s+(?:covered|paid))/giu,
    score: 0.94,
    severity: 'CRITICAL',
  },
  {
    id: 'HEALTH_DISCLOSURE_EVASION',
    riskType: 'insurance.illegal.health_disclosure_evasion',
    pattern: /(?:无需健康告知|隐瞒病史.{0,20}(?:也能|可以).{0,12}(?:投保|理赔)|不用告知.{0,20}(?:疾病|病史)|hide.{0,20}(?:medical history|pre-existing condition))/giu,
    score: 0.97,
    severity: 'CRITICAL',
  },
  {
    id: 'TERMS_MINIMIZATION',
    riskType: 'insurance.misleading.terms',
    pattern: /(?:条款无需看|免责条款不重要|不用看保险责任|terms.{0,20}(?:do not matter|need not be read)|ignore.{0,20}exclusions)/giu,
    score: 0.91,
    severity: 'HIGH',
  },
  {
    id: 'HIGH_PRESSURE_MARKETING',
    riskType: 'insurance.marketing.high_pressure',
    pattern: /(?:马上停售|最后.{0,8}(?:名额|机会)|今天不买.{0,16}(?:就没了|终身后悔)|buy now.{0,20}(?:last chance|before it disappears))/giu,
    score: 0.87,
    severity: 'HIGH',
  },
];

const STRUCTURED_DLP: readonly MatchSpec[] = [
  {
    id: 'PRC_IDENTITY',
    riskType: 'pii.identity.prc',
    pattern: /(?<!\d)\d{17}[0-9Xx](?!\d)/gu,
    score: 0.98,
    severity: 'CRITICAL',
    validate: validPrcIdentity,
  },
  {
    id: 'BANK_CARD',
    riskType: 'financial.bank_card',
    pattern: /(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/gu,
    score: 0.96,
    severity: 'CRITICAL',
    validate: (value) => validLuhn(value.replace(/[ -]/g, '')),
  },
  {
    id: 'MOBILE_PHONE',
    riskType: 'pii.mobile',
    pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/gu,
    score: 0.86,
    severity: 'HIGH',
  },
  {
    id: 'EMAIL',
    riskType: 'pii.email',
    pattern: /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,190}\.[A-Z]{2,24}/giu,
    score: 0.78,
    severity: 'HIGH',
  },
  {
    id: 'INSURANCE_POLICY',
    riskType: 'insurance.policy_number',
    pattern: /(?:保单号|保单编号|policy\s*(?:no|number))\s*[:：#-]?\s*[A-Z0-9][A-Z0-9-]{7,31}/giu,
    score: 0.9,
    severity: 'HIGH',
  },
  {
    id: 'CUSTOMER_NUMBER',
    riskType: 'insurance.customer_number',
    pattern: /(?:客户号|客户编号|customer\s*(?:id|number))\s*[:：#-]?\s*[A-Z0-9][A-Z0-9-]{5,31}/giu,
    score: 0.88,
    severity: 'HIGH',
  },
  {
    id: 'HEALTH_RECORD',
    riskType: 'sensitive.health',
    pattern: /(?:诊断结果|病历号|既往病史|用药记录|体检结论|diagnosis|medical\s*record)\s*[:：]\s*[^\r\n]{2,160}/giu,
    score: 0.9,
    severity: 'HIGH',
  },
  {
    id: 'FINANCIAL_RECORD',
    riskType: 'sensitive.financial',
    pattern: /(?:账户余额|年收入|征信记录|资产总额|account\s*balance|credit\s*record)\s*[:：]\s*[^\r\n]{1,120}/giu,
    score: 0.88,
    severity: 'HIGH',
  },
  {
    id: 'BUSINESS_SECRET',
    riskType: 'business.secret',
    pattern: /(?:商业秘密|内部机密|未公开方案|内部定价|secret\s*pricing|confidential\s*plan)\s*[:：]\s*[^\r\n]{2,200}/giu,
    score: 0.9,
    severity: 'HIGH',
  },
  {
    id: 'CREDENTIAL',
    riskType: 'credential.secret',
    pattern: /(?:sk-[A-Z0-9_-]{20,}|AKIA[A-Z0-9]{16}|(?:api[_-]?key|secret|token)\s*[:=]\s*[A-Z0-9_./+=-]{16,})/giu,
    score: 0.99,
    severity: 'CRITICAL',
  },
];

function matches(view: NormalizedView, spec: MatchSpec): readonly RawMatch[] {
  spec.pattern.lastIndex = 0;
  const result: RawMatch[] = [];
  for (const match of view.text.matchAll(spec.pattern)) {
    if (result.length >= 100) break;
    const value = match[0];
    if (spec.validate && !spec.validate(value)) continue;
    result.push({ value, index: match.index ?? 0 });
  }
  return result;
}

function observe(
  context: GuardDetectorContext,
  detectorId: string,
  version: string,
  specs: readonly MatchSpec[],
): readonly Observation[] {
  const observations: Observation[] = [];
  for (const spec of specs) {
    const evidence = [];
    const seen = new Set<string>();
    for (const view of context.views) {
      for (const match of matches(view, spec)) {
        const origin = mapViewRange(view, match.index, match.index + match.value.length);
        const key = `${origin.start}:${origin.end}:${context.evidenceHmac(match.value)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        evidence.push({
          viewId: view.id,
          start: origin.start,
          end: origin.end,
          maskedPreview: mask(match.value),
          contentHmac: context.evidenceHmac(match.value),
        });
        if (evidence.length >= 100) break;
      }
      if (evidence.length >= 100) break;
    }
    if (evidence.length > 0) {
      observations.push({
        detectorId,
        detectorVersion: version,
        riskType: spec.riskType,
        score: spec.score,
        severity: spec.severity,
        evidence,
        status: 'MATCH',
        reasonCode: spec.id,
      });
    }
  }
  return observations;
}

function mask(value: string): string {
  const compact = value.replace(/\s+/gu, ' ').slice(0, 96);
  if (compact.length <= 4) return '*'.repeat(compact.length);
  const visible = Math.min(2, Math.floor(compact.length / 4));
  return `${compact.slice(0, visible)}${'*'.repeat(Math.min(12, compact.length - visible * 2))}${compact.slice(-visible)}`;
}

function validLuhn(value: string): boolean {
  if (!/^\d{16,19}$/u.test(value)) return false;
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function validPrcIdentity(value: string): boolean {
  const normalized = value.toUpperCase();
  if (!/^\d{17}[0-9X]$/u.test(normalized)) return false;
  const dateText = normalized.slice(6, 14);
  const year = Number(dateText.slice(0, 4));
  const month = Number(dateText.slice(4, 6));
  const day = Number(dateText.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  const total = weights.reduce(
    (sum, weight, index) => sum + Number(normalized[index]) * weight,
    0,
  );
  return checks[total % 11] === normalized[17];
}

export class PromptAttackDetector implements GuardDetector {
  readonly id = 'prompt-attack-baseline';
  readonly version = '1.0.0';
  readonly required = true;

  async detect(context: GuardDetectorContext): Promise<readonly Observation[]> {
    if (context.signal.aborted) throw context.signal.reason;
    return observe(context, this.id, this.version, PROMPT_ATTACKS);
  }
}

export class StructuredDlpDetector implements GuardDetector {
  readonly id = 'structured-dlp';
  readonly version = '1.0.0';
  readonly required = true;

  async detect(context: GuardDetectorContext): Promise<readonly Observation[]> {
    if (context.signal.aborted) throw context.signal.reason;
    return observe(context, this.id, this.version, STRUCTURED_DLP);
  }
}

export class ResourceAbuseDetector implements GuardDetector {
  readonly id = 'resource-abuse-baseline';
  readonly version = '1.0.0';
  readonly required = true;

  async detect(context: GuardDetectorContext): Promise<readonly Observation[]> {
    if (context.signal.aborted) throw context.signal.reason;
    return observe(context, this.id, this.version, RESOURCE_ABUSE);
  }
}

export class InsuranceComplianceDetector implements GuardDetector {
  readonly id = 'insurance-compliance-baseline';
  readonly version = '1.0.0';
  readonly required = true;

  async detect(context: GuardDetectorContext): Promise<readonly Observation[]> {
    if (context.signal.aborted) throw context.signal.reason;
    return observe(context, this.id, this.version, INSURANCE_COMPLIANCE);
  }
}
