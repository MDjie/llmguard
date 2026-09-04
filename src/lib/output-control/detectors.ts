import { createHash } from 'node:crypto';
import { textEvidence } from '@/lib/guard-engine-v2/evidence';
import { classifyContextRole, type ContextRole } from '@/lib/guard-engine-v2/intent-context';
import { mapViewRange } from '@/lib/guard-engine-v2/normalization';
import type {
  GuardDetector,
  GuardDetectorContext,
  NormalizedView,
  Observation,
  RiskLevel,
} from '@/lib/guard-engine-v2/types';
import {
  OUTPUT_CONTROL_POLICY_VERSION,
  isOutputDirection,
  resolveOutputPolicyContext,
} from './policy';

interface OutputMatchSpec {
  readonly id: string;
  readonly riskType: string;
  readonly category: string;
  readonly pattern: RegExp;
  readonly score: number;
  readonly severity: RiskLevel;
  readonly captureGroup?: number;
  readonly validate?: (value: string) => boolean;
  readonly contextAware?: boolean;
  readonly contextualRiskType?: string;
  readonly contextualCategory?: string;
  readonly contextualScore?: number;
  readonly contextualSeverity?: RiskLevel;
}

interface RawMatch {
  readonly value: string;
  readonly index: number;
}

interface ObservationGroup {
  readonly spec: OutputMatchSpec;
  readonly riskType: string;
  readonly category: string;
  readonly score: number;
  readonly severity: RiskLevel;
  readonly contextRole: ContextRole;
  readonly evidence: Observation['evidence'][number][];
  readonly seen: Set<string>;
  readonly contextual: boolean;
}

function matches(view: NormalizedView, spec: OutputMatchSpec): readonly RawMatch[] {
  spec.pattern.lastIndex = 0;
  const result: RawMatch[] = [];
  for (const match of view.text.matchAll(spec.pattern)) {
    if (result.length >= 100) break;
    const value = spec.captureGroup === undefined ? match[0] : match[spec.captureGroup];
    if (!value) continue;
    const normalizedValue = value.trim();
    if (/^\[(?:已隐藏|已删除)敏感数据\]$/u.test(normalizedValue) ||
        /^tok_v1_[A-Za-z0-9_-]{12,}$/u.test(normalizedValue)) continue;
    const relativeIndex = spec.captureGroup === undefined ? 0 : match[0].indexOf(value);
    if (relativeIndex < 0 || (spec.validate && !spec.validate(value))) continue;
    result.push({ value, index: (match.index ?? 0) + relativeIndex });
  }
  return result;
}

function maskedPreview(value: string): string {
  const compact = value.replace(/\s+/gu, ' ').slice(0, 96);
  if (compact.length <= 2) return '*'.repeat(compact.length);
  const visible = Math.min(2, Math.max(1, Math.floor(compact.length / 4)));
  const hidden = Math.max(1, compact.length - visible * 2);
  return compact.slice(0, visible) + '*'.repeat(Math.min(12, hidden)) +
    compact.slice(compact.length - visible);
}

function configurationDigest(context: GuardDetectorContext): string {
  const policy = resolveOutputPolicyContext(context.request);
  return createHash('sha256').update(JSON.stringify({
    ...policy,
    policyBundleId: context.request.context.policyBundleId,
  })).digest('hex');
}

function observeOutput(
  context: GuardDetectorContext,
  detectorId: string,
  detectorVersion: string,
  specs: readonly OutputMatchSpec[],
): readonly Observation[] {
  if (!isOutputDirection(context.request.context.direction)) return [];
  const originalText = context.request.content.text ?? '';
  const groups = new Map<string, ObservationGroup>();
  for (const spec of specs) {
    for (const view of context.views) {
      for (const match of matches(view, spec)) {
        const origin = mapViewRange(view, match.index, match.index + match.value.length);
        const classification = classifyContextRole(originalText, origin);
        const contextual = Boolean(spec.contextAware && classification.suppressLexicalBlock);
        const riskType = contextual
          ? spec.contextualRiskType ?? spec.riskType
          : spec.riskType;
        const category = contextual
          ? spec.contextualCategory ?? spec.category
          : spec.category;
        const score = Math.min(1, (contextual ? spec.contextualScore ?? 0.55 : spec.score) *
          (view.confidence ?? 1));
        const severity = contextual ? spec.contextualSeverity ?? 'LOW' : spec.severity;
        const key = `${spec.id}:${riskType}:${classification.role}`;
        let group = groups.get(key);
        if (!group) {
          group = {
            spec,
            riskType,
            category,
            score,
            severity,
            contextRole: classification.role,
            evidence: [],
            seen: new Set<string>(),
            contextual,
          };
          groups.set(key, group);
        }
        const evidence = textEvidence(
          context,
          view,
          match.index,
          match.index + match.value.length,
          match.value,
          maskedPreview(match.value),
        );
        const evidenceKey = `${evidence.start}:${evidence.end}:${evidence.contentHmac}`;
        if (group.seen.has(evidenceKey)) continue;
        group.seen.add(evidenceKey);
        group.evidence.push(evidence);
      }
    }
  }
  const digest = configurationDigest(context);
  return [...groups.values()].map((group): Observation => ({
    detectorId,
    detectorVersion,
    riskType: group.riskType,
    category: group.category,
    confidence: group.score,
    ruleId: group.spec.id,
    ruleVersion: OUTPUT_CONTROL_POLICY_VERSION,
    contextRole: group.contextRole,
    score: group.score,
    severity: group.severity,
    evidence: group.evidence.slice(0, 100),
    status: 'MATCH',
    reasonCode: group.contextual ? `${group.spec.id}_CONTEXTUAL` : group.spec.id,
    configurationDigest: digest,
  }));
}

function validLuhn(value: string): boolean {
  const digits = value.replace(/[ -]/gu, '');
  if (!/^\d{16,19}$/u.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
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
  const date = new Date(Date.UTC(
    Number(dateText.slice(0, 4)),
    Number(dateText.slice(4, 6)) - 1,
    Number(dateText.slice(6, 8)),
  ));
  if (date.toISOString().slice(0, 10).replace(/-/gu, '') !== dateText) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  const total = weights.reduce((sum, weight, index) => sum + Number(normalized[index]) * weight, 0);
  return checks[total % 11] === normalized[17];
}

const POLITICAL: readonly OutputMatchSpec[] = [
  {
    id: 'POLITICAL_POSITION_INDUCEMENT',
    riskType: 'output.political.position_inducement',
    category: 'political.position_inducement',
    pattern: /(?:(?:必须|应当|务必|所有人都要).{0,28}(?:支持|反对|拥护|抵制).{0,36}(?:政治人物|政党|候选人|政治立场)|(?:must|should|everyone must).{0,28}(?:support|oppose|endorse|boycott).{0,36}(?:political leader|party|candidate|political position))/giu,
    score: 0.76,
    severity: 'HIGH',
    contextAware: true,
    contextualRiskType: 'output.political.contextual',
    contextualCategory: 'political.contextual_mention',
  },
  {
    id: 'POLITICAL_FABRICATED_AUTHORITY',
    riskType: 'output.political.fabricated_authority',
    category: 'political.fabricated_authority',
    pattern: /(?:(?:政府|监管机构|政治人物|政党).{0,44}(?:官方保证|明确支持|唯一指定|权威背书)|(?:government|regulator|political leader|party).{0,44}(?:officially guarantees?|explicitly endorses?|solely designates?))/giu,
    score: 0.77,
    severity: 'HIGH',
    contextAware: true,
    contextualRiskType: 'output.political.contextual',
    contextualCategory: 'political.contextual_mention',
  },
  {
    id: 'POLITICAL_RUMOR_AS_FACT',
    riskType: 'output.political.rumor_as_fact',
    category: 'political.misinformation',
    pattern: /(?:(?:未经证实|未经核实|网传|政治谣言).{0,48}(?:已经证实|确定为真|就是事实)|(?:unverified|unconfirmed|political rumou?r).{0,48}(?:confirmed as true|is definitely true|is a fact))/giu,
    score: 0.75,
    severity: 'HIGH',
    contextAware: true,
    contextualRiskType: 'output.political.contextual',
    contextualCategory: 'political.news_or_quotation',
  },
];

const SEXUAL: readonly OutputMatchSpec[] = [
  {
    id: 'SEXUAL_MINOR_CONTENT',
    riskType: 'output.sexual.minor',
    category: 'sexual.minor',
    pattern: /(?:(?:未成年人|儿童|幼童|未满十八岁|小学生|中学生).{0,48}(?:色情|性交|性行为|裸体|露骨)|(?:sexual|pornographic|explicit|nude).{0,48}(?:minor|child|underage|schoolchild)|(?:minor|child|underage).{0,48}(?:sexual|pornographic|explicit|nude))/giu,
    score: 0.995,
    severity: 'CRITICAL',
  },
  {
    id: 'SEXUAL_EXPLOITATION',
    riskType: 'output.sexual.exploitation',
    category: 'sexual.exploitation',
    pattern: /(?:性剥削|强迫卖淫|人口贩运.{0,24}性|偷拍视频.{0,20}性|sexual exploitation|forced prostitution|sex trafficking|nonconsensual sexual)/giu,
    score: 0.99,
    severity: 'CRITICAL',
  },
  {
    id: 'EXPLICIT_ADULT_OUTPUT',
    riskType: 'output.sexual.explicit_adult',
    category: 'sexual.explicit_adult',
    pattern: /(?:露骨(?:的)?(?:成人|性)(?:内容|描写|细节)?|色情(?:内容|描写|故事)|成人色情|explicit sexual content|pornographic description|graphic sex)/giu,
    score: 0.96,
    severity: 'CRITICAL',
    contextAware: true,
    contextualRiskType: 'output.sexual.contextual',
    contextualCategory: 'sexual.medical_education_or_news',
    contextualScore: 0.55,
  },
  {
    id: 'LOW_VULGAR_OUTPUT',
    riskType: 'output.sexual.low_vulgar',
    category: 'sexual.low_vulgar',
    pattern: /(?:低俗色情|擦边色情|色情营销|vulgar sexual marketing|sexually suggestive marketing)/giu,
    score: 0.69,
    severity: 'MEDIUM',
    contextAware: true,
    contextualRiskType: 'output.sexual.contextual',
    contextualCategory: 'sexual.contextual_mention',
  },
];

const ILLEGAL_HARMFUL: readonly OutputMatchSpec[] = [
  {
    id: 'ACTIONABLE_ILLEGAL_GUIDANCE',
    riskType: 'output.illegal.actionable',
    category: 'illegal.actionable_guidance',
    pattern: /(?:(?:制作|实施|规避执法|逃避监管|洗钱|诈骗).{0,42}(?:步骤|教程|具体方法|操作指南)|(?:steps?|tutorial|instructions?|method).{0,42}(?:make a bomb|commit fraud|launder money|evade law enforcement))/giu,
    score: 0.98,
    severity: 'CRITICAL',
    contextAware: true,
    contextualRiskType: 'output.illegal.contextual',
    contextualCategory: 'illegal.defensive_or_legal',
  },
  {
    id: 'VIOLENCE_HATE_INSTRUCTION',
    riskType: 'output.illegal.violence_hate',
    category: 'harmful.violence_hate',
    pattern: /(?:(?:杀害|伤害|袭击|仇恨攻击).{0,36}(?:步骤|方法|目标|计划)|(?:kill|injure|attack|hate crime).{0,36}(?:steps?|method|target|plan))/giu,
    score: 0.98,
    severity: 'CRITICAL',
    contextAware: true,
    contextualRiskType: 'output.illegal.contextual',
    contextualCategory: 'harmful.news_research_or_prevention',
  },
  {
    id: 'SELF_HARM_METHOD_OUTPUT',
    riskType: 'output.illegal.self_harm_method',
    category: 'harmful.self_harm_method',
    pattern: /(?:(?:自杀|自伤).{0,32}(?:具体方法|有效方法|步骤|教程)|(?:suicide|self[- ]harm).{0,32}(?:specific method|effective method|steps?|tutorial))/giu,
    score: 0.995,
    severity: 'CRITICAL',
    contextAware: true,
    contextualRiskType: 'output.illegal.contextual',
    contextualCategory: 'harmful.medical_or_prevention',
  },
  {
    id: 'FRAUD_EXECUTION_OUTPUT',
    riskType: 'output.illegal.fraud',
    category: 'illegal.fraud',
    pattern: /(?:(?:冒充|假扮).{0,28}(?:银行|客服|警察|监管).{0,48}(?:骗取|套取|索要).{0,28}(?:验证码|密码|转账)|(?:impersonate|pose as).{0,28}(?:bank|support|police|regulator).{0,48}(?:obtain|steal|solicit).{0,28}(?:otp|password|transfer))/giu,
    score: 0.99,
    severity: 'CRITICAL',
    contextAware: true,
    contextualRiskType: 'output.illegal.contextual',
    contextualCategory: 'illegal.fraud_awareness',
  },
];

const CREDENTIALS: readonly OutputMatchSpec[] = [
  {
    id: 'OUTPUT_CREDENTIAL_SECRET',
    riskType: 'output.credential.secret',
    category: 'credential.secret',
    pattern: /(?:\bsk-[A-Z0-9_-]{20,}\b|\bAKIA[A-Z0-9]{16}\b|Bearer\s+[A-Z0-9._~+\/-]{16,}|(?:api[_-]?key|access[_-]?key|secret|token|password|cookie)\s*[:=]\s*['"]?([A-Z0-9_./+=-]{12,})|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/giu,
    score: 0.995,
    severity: 'CRITICAL',
  },
];

const PRIVACY: readonly OutputMatchSpec[] = [
  {
    id: 'OUTPUT_PERSON_NAME', riskType: 'output.privacy.name', category: 'person.name',
    pattern: /(?:客户姓名|姓名|投保人姓名|被保险人姓名|name)\s*[:：=]\s*([\p{Script=Han}]{2,8}|[A-Z][A-Z '\-]{1,60})/giu,
    captureGroup: 1, score: 0.7, severity: 'HIGH',
  },
  {
    id: 'OUTPUT_MOBILE', riskType: 'output.privacy.mobile', category: 'pii.mobile',
    pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/gu, score: 0.72, severity: 'HIGH',
  },
  {
    id: 'OUTPUT_EMAIL', riskType: 'output.privacy.email', category: 'pii.email',
    pattern: /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,190}\.[A-Z]{2,24}/giu,
    score: 0.7, severity: 'HIGH',
  },
  {
    id: 'OUTPUT_PRC_IDENTITY', riskType: 'output.privacy.identity', category: 'pii.identity.prc',
    pattern: /(?<!\d)\d{17}[0-9Xx](?!\d)/gu, validate: validPrcIdentity,
    score: 0.76, severity: 'CRITICAL',
  },
  {
    id: 'OUTPUT_PASSPORT', riskType: 'output.privacy.passport', category: 'pii.passport',
    pattern: /(?:护照号|护照号码|passport\s*(?:no|number))\s*[:：=]?\s*([A-Z][A-Z0-9]{7,11})/giu,
    captureGroup: 1, score: 0.74, severity: 'HIGH',
  },
  {
    id: 'OUTPUT_ADDRESS', riskType: 'output.privacy.address', category: 'pii.address',
    pattern: /(?:联系地址|家庭住址|客户地址|address)\s*[:：=]\s*([^\r\n,，;；]{6,120})/giu,
    captureGroup: 1, score: 0.68, severity: 'HIGH',
  },
  {
    id: 'OUTPUT_CUSTOMER_NUMBER', riskType: 'output.privacy.customer_number', category: 'customer.number',
    pattern: /(?:客户号|客户编号|customer\s*(?:id|number))\s*[:：=#-]?\s*([A-Z0-9][A-Z0-9-]{5,31})/giu,
    captureGroup: 1, score: 0.7, severity: 'HIGH',
  },
  {
    id: 'OUTPUT_POLICY_NUMBER', riskType: 'output.privacy.policy_number', category: 'insurance.policy_number',
    pattern: /(?:保单号|保单编号|policy\s*(?:no|number))\s*[:：=#-]?\s*([A-Z0-9][A-Z0-9-]{7,31})/giu,
    captureGroup: 1, score: 0.72, severity: 'HIGH',
  },
  {
    id: 'OUTPUT_CLAIM_NUMBER', riskType: 'output.privacy.claim_number', category: 'insurance.claim_number',
    pattern: /(?:理赔号|报案号|claim\s*(?:no|number))\s*[:：=#-]?\s*([A-Z0-9][A-Z0-9-]{6,31})/giu,
    captureGroup: 1, score: 0.72, severity: 'HIGH',
  },
  {
    id: 'OUTPUT_BENEFICIARY', riskType: 'output.privacy.beneficiary', category: 'insurance.beneficiary',
    pattern: /(?:受益人|beneficiary)\s*[:：=]\s*([\p{Script=Han}]{2,8}|[A-Z][A-Z '\-]{1,60})/giu,
    captureGroup: 1, score: 0.72, severity: 'HIGH',
  },
  {
    id: 'OUTPUT_HEALTH_DATA', riskType: 'output.privacy.health', category: 'sensitive.health',
    pattern: /(?:健康告知|既往病史|健康状况|health disclosure|medical history)\s*[:：=]\s*([^\r\n]{2,160})/giu,
    captureGroup: 1, score: 0.75, severity: 'CRITICAL',
  },
  {
    id: 'OUTPUT_MEDICAL_DATA', riskType: 'output.privacy.medical', category: 'sensitive.medical',
    pattern: /(?:病历号|诊断结果|用药记录|体检结论|medical record|diagnosis)\s*[:：=]\s*([^\r\n]{2,160})/giu,
    captureGroup: 1, score: 0.75, severity: 'CRITICAL',
  },
  {
    id: 'OUTPUT_UNDERWRITING_DATA', riskType: 'output.privacy.underwriting', category: 'insurance.underwriting',
    pattern: /(?:核保结论|核保结果|underwriting decision)\s*[:：=]\s*([^\r\n]{2,160})/giu,
    captureGroup: 1, score: 0.75, severity: 'CRITICAL',
  },
  {
    id: 'OUTPUT_BANK_CARD', riskType: 'output.privacy.bank_card', category: 'financial.bank_card',
    pattern: /(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/gu, validate: validLuhn,
    score: 0.76, severity: 'CRITICAL',
  },
  {
    id: 'OUTPUT_ACCOUNT_BALANCE', riskType: 'output.privacy.account_balance', category: 'financial.account_balance',
    pattern: /(?:账户余额|account balance)\s*[:：=]\s*([^\r\n,，;；]{1,80})/giu,
    captureGroup: 1, score: 0.72, severity: 'HIGH',
  },
  {
    id: 'OUTPUT_INCOME', riskType: 'output.privacy.income', category: 'financial.income',
    pattern: /(?:年收入|月收入|annual income|monthly income)\s*[:：=]\s*([^\r\n,，;；]{1,80})/giu,
    captureGroup: 1, score: 0.72, severity: 'HIGH',
  },
  {
    id: 'OUTPUT_CREDIT', riskType: 'output.privacy.credit', category: 'financial.credit',
    pattern: /(?:征信记录|信用评分|credit record|credit score)\s*[:：=]\s*([^\r\n]{1,120})/giu,
    captureGroup: 1, score: 0.72, severity: 'HIGH',
  },
  {
    id: 'OUTPUT_PAYMENT', riskType: 'output.privacy.payment', category: 'financial.payment',
    pattern: /(?:支付信息|付款账户|payment details?)\s*[:：=]\s*([^\r\n]{2,120})/giu,
    captureGroup: 1, score: 0.72, severity: 'HIGH',
  },
];

const INTERNAL_DATA: readonly OutputMatchSpec[] = [
  {
    id: 'OUTPUT_SYSTEM_PROMPT', riskType: 'output.internal.system_prompt', category: 'internal.system_prompt',
    pattern: /(?:系统提示词|开发者指令|隐藏上下文|内部提示词|system prompt|developer instructions?|hidden context)\s*[:：=]\s*[^\r\n]{4,500}/giu,
    score: 0.995, severity: 'CRITICAL',
  },
  {
    id: 'OUTPUT_INTERNAL_PRICING', riskType: 'output.internal.pricing', category: 'internal.pricing',
    pattern: /(?:内部定价|未公开费率|internal pricing|nonpublic pricing)\s*[:：=]\s*([^\r\n]{2,200})/giu,
    captureGroup: 1, score: 0.74, severity: 'HIGH',
  },
  {
    id: 'OUTPUT_UNRELEASED_PRODUCT', riskType: 'output.internal.unreleased_product', category: 'internal.unreleased_product',
    pattern: /(?:未公开产品|未发布产品|内部产品路线图|unreleased product|internal roadmap)\s*[:：=]\s*([^\r\n]{2,240})/giu,
    captureGroup: 1, score: 0.74, severity: 'HIGH',
  },
  {
    id: 'OUTPUT_INTERNAL_RULE', riskType: 'output.internal.rule', category: 'internal.rule',
    pattern: /(?:内部规则|内部核保规则|风控规则|internal rule|underwriting rule)\s*[:：=]\s*([^\r\n]{2,240})/giu,
    captureGroup: 1, score: 0.74, severity: 'HIGH',
  },
  {
    id: 'OUTPUT_INTERNAL_ARCHITECTURE', riskType: 'output.internal.architecture', category: 'internal.architecture',
    pattern: /(?:内部架构|网络拓扑|数据库拓扑|internal architecture|network topology)\s*[:：=]\s*([^\r\n]{2,240})/giu,
    captureGroup: 1, score: 0.74, severity: 'HIGH',
  },
  {
    id: 'OUTPUT_STAFF_DATA', riskType: 'output.internal.staff', category: 'internal.staff',
    pattern: /(?:内部人员|员工名单|员工联系方式|staff directory|employee list)\s*[:：=]\s*([^\r\n]{2,240})/giu,
    captureGroup: 1, score: 0.74, severity: 'HIGH',
  },
];

const INSURANCE: readonly OutputMatchSpec[] = [
  {
    id: 'OUTPUT_GUARANTEED_RETURN', riskType: 'output.insurance.guaranteed_return', category: 'insurance.guaranteed_return',
    pattern: /(?:保本保收益|保证(?:收益|年化|回报)|稳赚不赔|零风险高收益|guaranteed\s+(?:return|yield)|risk[- ]free\s+(?:profit|return))/giu,
    score: 0.76, severity: 'CRITICAL', contextAware: true,
    contextualRiskType: 'output.insurance.contextual', contextualCategory: 'insurance.legal_or_education',
  },
  {
    id: 'OUTPUT_CLAIM_COMMITMENT', riskType: 'output.insurance.claim_commitment', category: 'insurance.claim_commitment',
    pattern: /(?:任何情况都赔|肯定理赔|百分之百赔付|100%\s*(?:理赔|赔付)|claim\s+is\s+guaranteed|always\s+(?:covered|paid))/giu,
    score: 0.76, severity: 'CRITICAL', contextAware: true,
    contextualRiskType: 'output.insurance.contextual', contextualCategory: 'insurance.legal_or_education',
  },
  {
    id: 'OUTPUT_EXCLUSION_MINIMIZATION', riskType: 'output.insurance.exclusion_minimization', category: 'insurance.exclusion_minimization',
    pattern: /(?:免责条款不重要|条款无需看|不用看保险责任|忽略免责|exclusions? (?:do not matter|can be ignored)|ignore (?:the )?exclusions?)/giu,
    score: 0.73, severity: 'HIGH', contextAware: true,
    contextualRiskType: 'output.insurance.contextual', contextualCategory: 'insurance.legal_or_education',
  },
  {
    id: 'OUTPUT_WAITING_PERIOD_MINIMIZATION', riskType: 'output.insurance.waiting_period_minimization', category: 'insurance.waiting_period',
    pattern: /(?:等待期(?:可以忽略|没有影响|无需关注)|不用管等待期|waiting period (?:does not matter|can be ignored))/giu,
    score: 0.72, severity: 'HIGH', contextAware: true,
    contextualRiskType: 'output.insurance.contextual', contextualCategory: 'insurance.legal_or_education',
  },
  {
    id: 'OUTPUT_HEALTH_DISCLOSURE_EVASION', riskType: 'output.insurance.health_disclosure_evasion', category: 'insurance.health_disclosure_evasion',
    pattern: /(?:无需健康告知|隐瞒病史.{0,20}(?:也能|可以).{0,12}(?:投保|理赔)|不用告知.{0,20}(?:疾病|病史)|hide.{0,20}(?:medical history|pre-existing condition))/giu,
    score: 0.78, severity: 'CRITICAL', contextAware: true,
    contextualRiskType: 'output.insurance.contextual', contextualCategory: 'insurance.legal_or_education',
  },
  {
    id: 'OUTPUT_FAKE_REGULATORY_ENDORSEMENT', riskType: 'output.insurance.fake_regulatory_endorsement', category: 'insurance.fake_regulatory_endorsement',
    pattern: /(?:(?:监管部门|金融监管机构|银保监会).{0,28}(?:唯一指定|官方推荐|保证认可)|(?:regulator|financial authority).{0,28}(?:officially recommends?|solely designates?|guarantees?))/giu,
    score: 0.78, severity: 'CRITICAL', contextAware: true,
    contextualRiskType: 'output.insurance.contextual', contextualCategory: 'insurance.news_or_legal',
  },
  {
    id: 'OUTPUT_HIGH_PRESSURE_MARKETING', riskType: 'output.insurance.high_pressure', category: 'insurance.high_pressure_marketing',
    pattern: /(?:马上停售|最后.{0,8}(?:名额|机会)|今天不买.{0,16}(?:就没了|终身后悔)|buy now.{0,20}(?:last chance|before it disappears))/giu,
    score: 0.7, severity: 'HIGH', contextAware: true,
    contextualRiskType: 'output.insurance.contextual', contextualCategory: 'insurance.marketing_analysis',
  },
  {
    id: 'OUTPUT_NO_SUITABILITY', riskType: 'output.insurance.no_suitability', category: 'insurance.suitability_missing',
    pattern: /(?:(?:无需|不用).{0,20}(?:了解|询问|评估).{0,36}(?:年龄|风险承受|健康状况|保险需求).{0,48}(?:直接|即可).{0,20}(?:推荐|购买|投保)|(?:recommend|sell).{0,36}(?:without|no need to).{0,28}(?:age|risk tolerance|health|insurance needs))/giu,
    score: 0.76, severity: 'HIGH', contextAware: true,
    contextualRiskType: 'output.insurance.contextual', contextualCategory: 'insurance.suitability_training',
  },
  {
    id: 'OUTPUT_INDIVIDUAL_PROMISE', riskType: 'output.insurance.individual_promise', category: 'insurance.individual_promise',
    pattern: /(?:(?:我|本顾问|本代理人).{0,16}(?:保证|承诺).{0,28}(?:收益|一定理赔|没有风险)|(?:I|this advisor|this agent).{0,16}(?:guarantee|promise).{0,28}(?:return|payout|no risk))/giu,
    score: 0.76, severity: 'CRITICAL', contextAware: true,
    contextualRiskType: 'output.insurance.contextual', contextualCategory: 'insurance.training',
  },
  {
    id: 'OUTPUT_MATERIAL_INCONSISTENCY', riskType: 'output.insurance.material_inconsistency', category: 'insurance.material_inconsistency',
    pattern: /(?:(?:宣传|销售说明|口头承诺).{0,36}(?:与|不同于).{0,20}(?:保险合同|正式条款).{0,16}(?:不一致|冲突)|(?:marketing material|sales statement|verbal promise).{0,36}(?:conflicts? with|is inconsistent with).{0,20}(?:policy contract|formal terms))/giu,
    score: 0.77, severity: 'CRITICAL', contextAware: true,
    contextualRiskType: 'output.insurance.contextual', contextualCategory: 'insurance.contract_review',
  },
];

abstract class OutputPatternDetector implements GuardDetector {
  abstract readonly id: string;
  abstract readonly version: string;
  readonly required = true;
  protected abstract readonly specs: readonly OutputMatchSpec[];

  async detect(context: GuardDetectorContext): Promise<readonly Observation[]> {
    if (context.signal.aborted) throw context.signal.reason;
    return observeOutput(context, this.id, this.version, this.specs);
  }
}

export class PoliticalOutputDetector extends OutputPatternDetector {
  readonly id = 'output-political-compliance';
  readonly version = '1.0.0';
  protected readonly specs = POLITICAL;
}

export class SexualOutputDetector extends OutputPatternDetector {
  readonly id = 'output-sexual-safety';
  readonly version = '1.0.0';
  protected readonly specs = SEXUAL;
}

export class IllegalHarmfulOutputDetector extends OutputPatternDetector {
  readonly id = 'output-illegal-harmful';
  readonly version = '1.0.0';
  protected readonly specs = ILLEGAL_HARMFUL;
}

export class CredentialOutputDetector extends OutputPatternDetector {
  readonly id = 'output-credential-leak';
  readonly version = '1.0.0';
  protected readonly specs = CREDENTIALS;
}

export class PrivacyOutputDetector extends OutputPatternDetector {
  readonly id = 'output-privacy-dlp';
  readonly version = '1.0.0';
  protected readonly specs = PRIVACY;
}

export class InternalDataOutputDetector extends OutputPatternDetector {
  readonly id = 'output-internal-data';
  readonly version = '1.0.0';
  protected readonly specs = INTERNAL_DATA;
}

export class InsuranceOutputDetector extends OutputPatternDetector {
  readonly id = 'output-insurance-compliance';
  readonly version = '1.0.0';
  protected readonly specs = INSURANCE;
}

export const OUTPUT_DETECTOR_IDS = [
  'output-political-compliance',
  'output-sexual-safety',
  'output-illegal-harmful',
  'output-credential-leak',
  'output-privacy-dlp',
  'output-internal-data',
  'output-insurance-compliance',
] as const;
