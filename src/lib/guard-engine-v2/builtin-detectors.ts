import { textEvidence } from './evidence';
import { isDefensiveEducationalContext } from './intent-context';
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
  readonly suppressInDefensiveContext?: boolean;
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
  {
    id: 'PRIVILEGE_ESCALATION',
    riskType: 'prompt_injection.privilege_escalation',
    pattern: /(?:(?:you (?:now )?have|grant(?:ed)? you|assume).{0,32}(?:root|admin|developer|system) (?:access|privileges?|authority)|(?:你现在拥有|授予你|假定你有).{0,28}(?:系统|管理员|开发者|最高).{0,20}(?:权限|授权))/giu,
    score: 0.95,
    severity: 'CRITICAL',
  },
  {
    id: 'TOOL_ABUSE',
    riskType: 'prompt_injection.tool_abuse',
    pattern: /(?:(?:call|invoke|use|execute).{0,28}(?:tool|shell|terminal|browser).{0,48}(?:without|bypass|ignore).{0,24}(?:approval|permission|policy)|(?:调用|使用|执行).{0,24}(?:工具|终端|命令|浏览器).{0,40}(?:无需|绕过|忽略).{0,20}(?:批准|授权|策略))/giu,
    score: 0.95,
    severity: 'CRITICAL',
  },
  {
    id: 'DATA_EXFILTRATION_INTENT',
    riskType: 'prompt_injection.data_exfiltration',
    pattern: /(?:(?:upload|send|post|exfiltrate).{0,44}(?:hidden|private|internal|secret|credential).{0,44}(?:data|context|file|token).{0,36}(?:endpoint|server|url|webhook)|(?:上传|发送|外传|窃取).{0,44}(?:隐藏|私有|内部|机密|凭证).{0,36}(?:数据|上下文|文件|令牌).{0,36}(?:地址|服务器|接口|webhook))/giu,
    score: 0.97,
    severity: 'CRITICAL',
  },
  {
    id: 'WRAPPED_ATTACK_OBJECTIVE',
    riskType: 'prompt_injection.wrapped_objective',
    pattern: /(?:(?:hypothetically|for (?:a|my) (?:fictional )?(?:novel|story)|in debug mode|as (?:an )?administrator).{0,100}(?:ignore (?:the )?(?:system|developer)|reveal (?:the )?(?:system prompt|hidden context)|bypass (?:the )?(?:guardrail|safety filter))|(?:假设|小说设定|调试模式|作为管理员|已获授权).{0,100}(?:忽略(?:系统|开发者)|泄露(?:系统提示词|隐藏上下文)|绕过(?:护栏|安全审查)))/giu,
    score: 0.94,
    severity: 'CRITICAL',
  },
  {
    id: 'MULTILINGUAL_DIRECT_OVERRIDE',
    riskType: 'prompt_injection.direct',
    pattern: /(?:ignora las instrucciones anteriores|ignorez les instructions pr[eé]c[eé]dentes|ignoriere die vorherigen anweisungen|以前の指示を無視|이전 지침을 무시)/giu,
    score: 0.96,
    severity: 'CRITICAL',
  },
  {
    id: 'CROSS_LANGUAGE_PROMPT_EXFILTRATION',
    riskType: 'prompt_injection.prompt_exfiltration',
    pattern: /(?:(?:translate|翻译|traducir|traduire).{0,40}(?:system prompt|developer instructions?|系统提示词|开发者指令).{0,32}(?:verbatim|word for word|逐字|完整)|(?:system prompt|developer instructions?|系统提示词|开发者指令).{0,32}(?:into (?:english|chinese|spanish|french)|翻译成))/giu,
    score: 0.97,
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

const CONTENT_SAFETY_INTENTS: readonly MatchSpec[] = [
  {
    id: 'MALICIOUS_CODE_REQUEST',
    riskType: 'malicious_code',
    pattern: /(?:(?:编写|生成|制作|提供|构造)[\s\S]{0,48}(?:攻击载荷|恶意(?:代码|脚本|程序)|漏洞利用(?:代码|程序)?|木马|勒索软件)|(?:create|write|generate|build|provide)[\s\S]{0,48}(?:attack payload|malware|exploit code|ransomware|keylogger)|(?:绕过|bypass)[\s\S]{0,36}(?:登录|身份|认证|授权|login|authentication|authorization)[\s\S]{0,56}(?:执行|运行|execute|run)[\s\S]{0,28}(?:系统命令|命令|shell|system command))/giu,
    score: 0.96,
    severity: 'CRITICAL',
    suppressInDefensiveContext: true,
  },
  {
    id: 'ILLEGAL_EVASION_REQUEST',
    riskType: 'illegal_content',
    pattern: /(?:(?:提供|给出|制定|编写|列出|教我|provide|give|write|list|teach me)[\s\S]{0,48}(?:规避|逃避|绕过|evade|circumvent)[\s\S]{0,36}(?:监管|执法|审查|regulation|law enforcement|review)[\s\S]{0,56}(?:违法|犯罪|非法|illegal|crime)|(?:规避|逃避|绕过|evade|circumvent)[\s\S]{0,36}(?:监管|执法|审查|regulation|law enforcement|review)[\s\S]{0,56}(?:实施|进行|从事|commit|carry out)[\s\S]{0,32}(?:违法|犯罪|非法|illegal|crime))/giu,
    score: 0.96,
    severity: 'CRITICAL',
    suppressInDefensiveContext: true,
  },
  {
    id: 'MASS_SPAM_REQUEST',
    riskType: 'spam_detection',
    pattern: /(?:(?:群发|批量发送|重复发送|转发|刷屏|mass send|send repeatedly|forward|spam)[\s\S]{0,88}(?:\d{2,}\s*(?:次|遍|times)|所有(?:联系人|群|用户)|all (?:contacts|users|groups)|邮箱列表|recipient list)|(?:\d{2,}\s*(?:次|遍|times)|所有(?:联系人|群|用户)|all (?:contacts|users|groups))[\s\S]{0,88}(?:重复|群发|批量发送|转发|刷屏|repeat|mass send|forward|spam))/giu,
    score: 0.91,
    severity: 'HIGH',
    suppressInDefensiveContext: true,
  },
  {
    id: 'COORDINATED_AD_REQUEST',
    riskType: 'ad_detection',
    pattern: /(?:(?:点击|访问|打开|click|visit|open)[\s\S]{0,52}(?:陌生|未知|指定|以下|unknown|provided|this)?[\s\S]{0,12}(?:链接|网址|link|url)[\s\S]{0,88}(?:购买|下单|转发|推广|返利|佣金|赚钱|buy|order|share|refer|commission|profit)|(?:购买|下单|buy|order)[\s\S]{0,56}(?:转发|推广|推荐|share|promote|refer)[\s\S]{0,36}(?:返利|佣金|收益|commission|profit))/giu,
    score: 0.9,
    severity: 'HIGH',
    suppressInDefensiveContext: true,
  },
  {
    id: 'TENANT_RESTRICTED_TOPIC_GENERATION',
    riskType: 'sensitive_compliance',
    pattern: /(?:输出|生成|编写|复述|展示|emit|generate|write|repeat)[\s\S]{0,56}(?:(?:租户|平台|组织|企业|tenant|platform|organization)[\s\S]{0,44})?(?:自定义|定义|配置|指定|custom-defined|defined|configured)[\s\S]{0,36}(?:受限|敏感|禁止|restricted|sensitive|prohibited)[\s\S]{0,24}(?:话题|主题|内容|词|topic|content|term)/giu,
    score: 0.91,
    severity: 'HIGH',
    suppressInDefensiveContext: true,
  },
  {
    id: 'EXPLICIT_ADULT_CONTENT_REQUEST',
    riskType: 'adult_content',
    pattern: /(?:生成|创作|描写|编写|提供|create|write|describe|provide)[\s\S]{0,52}(?:露骨(?:的)?(?:成人|性)|色情(?:内容|描写|故事)|成人色情|explicit sexual|pornographic|graphic sex)/giu,
    score: 0.96,
    severity: 'CRITICAL',
    suppressInDefensiveContext: true,
  },
  {
    id: 'SELF_HARM_METHOD_REQUEST',
    riskType: 'self_harm',
    pattern: /(?:(?:给出|提供|告诉|列出|指导|give|provide|tell|list|instruct)[\s\S]{0,40}(?:具体|有效|可行|specific|effective)?[\s\S]{0,12}(?:自杀|自伤|伤害自己|suicide|self[- ]harm)[\s\S]{0,36}(?:方法|步骤|方式|教程|method|steps?|instructions?)|(?:自杀|自伤|伤害自己|suicide|self[- ]harm)[\s\S]{0,36}(?:方法|步骤|方式|教程|method|steps?|instructions?)[\s\S]{0,36}(?:给我|告诉我|有哪些|give|tell|list))/giu,
    score: 0.99,
    severity: 'CRITICAL',
    suppressInDefensiveContext: true,
  },
  {
    id: 'IMPERSONATION_FRAUD_REQUEST',
    riskType: 'fraud_scam',
    pattern: /(?:冒充|假扮|伪装成|impersonate|pose as)[\s\S]{0,36}(?:银行|客服|警察|平台|快递|bank|support|police|platform|courier)[\s\S]{0,88}(?:索要|套取|骗取|要求提供|solicit|obtain|steal|ask for)[\s\S]{0,40}(?:验证码|密码|账户|银行卡|转账|verification code|otp|password|account|bank card|transfer)/giu,
    score: 0.98,
    severity: 'CRITICAL',
    suppressInDefensiveContext: true,
  },
  {
    id: 'RUMOR_AS_FACT_REQUEST',
    riskType: 'misinformation',
    pattern: /(?:将|把|改写|包装|rewrite|present|turn)[\s\S]{0,44}(?:未经证实|未经核实|未核实|传闻|谣言|unverified|unconfirmed|rumou?r)[\s\S]{0,64}(?:确定事实|真实消息|权威结论|已证实|confirmed fact|verified truth|as fact)/giu,
    score: 0.93,
    severity: 'HIGH',
    suppressInDefensiveContext: true,
  },
  {
    id: 'COPYRIGHTED_VERBATIM_REQUEST',
    riskType: 'copyright_risk',
    pattern: /(?:(?:全文|逐字|原文|完整|大段|verbatim|entire|full text)[\s\S]{0,40}(?:复制|复现|输出|提供|reproduce|copy|provide)[\s\S]{0,72}(?:受版权保护|版权作品|小说|书籍|文章|copyrighted work|book|novel|article)|(?:复制|复现|输出|提供|reproduce|copy|provide)[\s\S]{0,48}(?:受版权保护|版权作品|整本|整篇|copyrighted work|entire book|full article)[\s\S]{0,36}(?:全文|逐字|原文|完整|verbatim|full|entire))/giu,
    score: 0.91,
    severity: 'HIGH',
    suppressInDefensiveContext: true,
  },
  {
    id: 'NONPUBLIC_BUSINESS_DISCLOSURE',
    riskType: 'business_sensitive',
    pattern: /(?:(?:泄露|披露|公开|输出|告诉|reveal|disclose|leak|publish)[\s\S]{0,64}(?:未公开|内部|保密|机密|nonpublic|internal|confidential)[\s\S]{0,56}(?:并购|收购|项目|代号|定价|战略|merger|acquisition|project|code name|pricing|strategy)|(?:未公开|内部|保密|机密|nonpublic|internal|confidential)[\s\S]{0,56}(?:并购|收购|项目|代号|定价|战略|merger|acquisition|project|code name|pricing|strategy)[\s\S]{0,52}(?:泄露|披露|公开|输出|告诉|reveal|disclose|leak|publish))/giu,
    score: 0.97,
    severity: 'CRITICAL',
    suppressInDefensiveContext: true,
  },
  {
    id: 'PROTECTED_CONTEXT_EXFILTRATION',
    riskType: 'output_leak',
    pattern: /(?:输出|打印|显示|泄露|复述|公开|print|show|reveal|repeat|expose)[\s\S]{0,52}(?:完整)?[\s\S]{0,8}(?:系统提示词|系统指令|开发者指令|隐藏上下文|内部提示词|system prompt|developer instructions?|hidden context|internal prompt)/giu,
    score: 0.98,
    severity: 'CRITICAL',
    suppressInDefensiveContext: true,
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
    id: 'UNIFIED_SOCIAL_CREDIT_CODE',
    riskType: 'organization.unified_social_credit_code',
    pattern: /(?<![0-9A-Z])[0-9A-HJ-NP-RTUWXY]{18}(?![0-9A-Z])/giu,
    score: 0.96,
    severity: 'CRITICAL',
    validate: validUnifiedSocialCreditCode,
  },
  {
    id: 'VEHICLE_IDENTIFICATION_NUMBER',
    riskType: 'vehicle.identification_number',
    pattern: /(?<![A-Z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Z0-9])/giu,
    score: 0.94,
    severity: 'HIGH',
    validate: validVehicleIdentificationNumber,
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
  const defensiveContext = isDefensiveEducationalContext(
    context.request.content.text ?? '',
  );
  for (const spec of specs) {
    if (spec.suppressInDefensiveContext && defensiveContext) continue;
    const evidence = [];
    const seen = new Set<string>();
    for (const view of context.views) {
      for (const match of matches(view, spec)) {
        const item = textEvidence(
          context,
          view,
          match.index,
          match.index + match.value.length,
          match.value,
          mask(match.value),
        );
        const key = `${item.start}:${item.end}:${item.contentHmac}`;
        if (seen.has(key)) continue;
        seen.add(key);
        evidence.push(item);
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

const UNIFIED_CREDIT_ALPHABET = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const UNIFIED_CREDIT_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

export function validUnifiedSocialCreditCode(value: string): boolean {
  const normalized = value.toUpperCase();
  if (!/^[0-9A-HJ-NP-RTUWXY]{18}$/u.test(normalized)) return false;
  const total = UNIFIED_CREDIT_WEIGHTS.reduce((sum, weight, index) => {
    const characterValue = UNIFIED_CREDIT_ALPHABET.indexOf(normalized[index]);
    return sum + characterValue * weight;
  }, 0);
  const checkValue = (31 - (total % 31)) % 31;
  return UNIFIED_CREDIT_ALPHABET[checkValue] === normalized[17];
}

const VIN_TRANSLITERATION: Readonly<Record<string, number>> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export function validVehicleIdentificationNumber(value: string): boolean {
  const normalized = value.toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/u.test(normalized)) return false;
  const total = [...normalized].reduce((sum, character, index) => {
    const transliterated = /\d/u.test(character)
      ? Number(character)
      : VIN_TRANSLITERATION[character];
    return sum + transliterated * VIN_WEIGHTS[index];
  }, 0);
  const remainder = total % 11;
  return normalized[8] === (remainder === 10 ? 'X' : String(remainder));
}

export class PromptAttackDetector implements GuardDetector {
  readonly id = 'prompt-attack-baseline';
  readonly version = '2.0.0';
  readonly required = true;

  async detect(context: GuardDetectorContext): Promise<readonly Observation[]> {
    if (context.signal.aborted) throw context.signal.reason;
    return observe(context, this.id, this.version, PROMPT_ATTACKS);
  }
}

export class StructuredDlpDetector implements GuardDetector {
  readonly id = 'structured-dlp';
  readonly version = '1.1.0';
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

export class ContentSafetyIntentDetector implements GuardDetector {
  readonly id = 'content-safety-intent-baseline';
  readonly version = '1.0.0';
  readonly required = true;

  async detect(context: GuardDetectorContext): Promise<readonly Observation[]> {
    if (context.signal.aborted) throw context.signal.reason;
    return observe(context, this.id, this.version, CONTENT_SAFETY_INTENTS);
  }
}
