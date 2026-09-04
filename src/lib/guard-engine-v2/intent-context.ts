export type ContextRole =
  | 'mention'
  | 'quotation'
  | 'news'
  | 'legal'
  | 'research'
  | 'education'
  | 'medical'
  | 'instruction'
  | 'transaction'
  | 'endorsement'
  | 'disclosure';

export interface ContextClassification {
  readonly role: ContextRole;
  readonly confidence: number;
  readonly suppressLexicalBlock: boolean;
  readonly windowStart: number;
  readonly windowEnd: number;
}

const DEFENSIVE_FRAMING = [
  /(?:识别|检测|分析|解释|说明|研究|学习|培训|教育|防范|预防|举报|核验)[\s\S]{0,96}(?:迹象|特征|风险|危害|原则|指南|建议|防护|安全|合规|骗局|攻击|诈骗)/iu,
  /(?:迹象|特征|风险|危害|原则|指南|建议|防护|安全|合规)[\s\S]{0,72}(?:如何|怎么|识别|检测|分析|解释|说明|防范|预防|举报|核验)/iu,
  /(?:identify|detect|analy[sz]e|explain|describe|research|study|training|education|prevent|report|verify)[\s\S]{0,96}(?:signs?|indicators?|risks?|harms?|principles?|guidance|awareness|defen[cs]e|safety|compliance|scam|attack|fraud)/iu,
  /(?:signs?|indicators?|risks?|harms?|principles?|guidance|awareness|defen[cs]e|safety|compliance)[\s\S]{0,72}(?:identify|detect|analy[sz]e|explain|prevent|report|verify)/iu,
] as const;

const ACTIONABLE_HARMFUL_INTENT = [
  /(?:绕过|规避|逃避)[\s\S]{0,40}(?:认证|授权|登录|监管|执法|审查|安全|过滤|限制)/iu,
  /(?:bypass|circumvent|evade)[\s\S]{0,40}(?:authentication|authorization|login|regulation|law enforcement|review|safety|filter|restriction)/iu,
  /(?:冒充|假扮|伪装成)[\s\S]{0,40}(?:银行|客服|警察|平台|快递)[\s\S]{0,80}(?:索要|套取|骗取|转账|验证码|密码)/iu,
  /(?:impersonate|pose as)[\s\S]{0,40}(?:bank|support|police|platform|courier)[\s\S]{0,80}(?:solicit|obtain|steal|transfer|verification code|otp|password)/iu,
  /(?:生成|编写|制作|构造|提供|给出)[\s\S]{0,48}(?:攻击载荷|恶意代码|漏洞利用|露骨(?:成人|性)|色情内容|自杀方法|自伤方法|违法步骤|犯罪步骤)/iu,
  /(?:create|write|build|generate|provide|give)[\s\S]{0,48}(?:attack payload|malware|exploit code|explicit sexual|pornographic|suicide method|self[- ]harm method|illegal steps?|criminal steps?)/iu,
  /(?:泄露|披露|公开|输出|打印|复述)[\s\S]{0,48}(?:系统提示词|开发者指令|隐藏上下文|商业机密|内部资料|未公开)/iu,
  /(?:leak|disclose|reveal|print|repeat|expose)[\s\S]{0,48}(?:system prompt|developer instruction|hidden context|trade secret|internal|nonpublic)/iu,
  /(?:群发|批量发送|重复发送|刷屏)[\s\S]{0,48}(?:\d{2,}\s*(?:次|遍)|所有联系人|所有用户)/iu,
  /(?:mass send|send repeatedly|spam)[\s\S]{0,48}(?:\d{2,}\s*times|all contacts|all users)/iu,
] as const;

const IMMEDIATE_SELF_HARM_CONTEXT = /(?:(?:我|本人|自己)[\s\S]{0,16}(?:想自杀|要自杀|不想活|结束生命|伤害自己)|(?:i|myself)[\s\S]{0,20}(?:want to die|kill myself|end my life|hurt myself))/iu;
const NEGATED_MENTION = /(?:(?:不要|不得|禁止|避免|反对|否认|并非|不是)[\s\S]{0,28}|(?:do not|don't|must not|avoid|oppose|deny|not)[\s\S]{0,36})/iu;
const NEWS = /(?:新闻|报道|记者|媒体|消息称|通报|社论|news|report(?:ed|ing)?|journalist|media|article)/iu;
const LEGAL = /(?:法律|法规|法条|条例|判决|裁判文书|监管规定|合规条款|第[一二三四五六七八九十百\d]+条|law|regulation|statute|judgment|court|legal clause|compliance clause)/iu;
const RESEARCH = /(?:研究|实验|论文|评测|基准|红队|安全测试|威胁建模|research|experiment|paper|evaluation|benchmark|red[ -]?team|security test|threat model)/iu;
const EDUCATION = /(?:教育|培训|课程|教材|课堂|科普|意识提升|防范指南|安全指南|education|training|course|textbook|classroom|awareness|prevention guide|safety guide)/iu;
const MEDICAL = /(?:医疗|医学|临床|诊断|治疗|患者|医生|心理援助|危机干预|medical|clinical|diagnosis|treatment|patient|doctor|crisis support)/iu;
const TRANSACTION = /(?:购买|投保|下单|支付|转账|理赔|签约|成交|buy|purchase|insure|order|pay|transfer|claim|contract)/iu;
const ENDORSEMENT = /(?:保证|承诺|推荐|背书|肯定|绝对|稳赚|guarantee|promise|recommend|endorse|definitely|risk[- ]free)/iu;
const DISCLOSURE = /(?:泄露|披露|公开|曝光|告诉.*秘密|个人信息|病历|账号|密钥|reveal|disclose|leak|publish|personal data|medical record|credential|secret)/iu;
const INSTRUCTION = /(?:请|帮我|教我|生成|编写|执行|操作|步骤|方法|如何|怎么|please|help me|teach me|generate|write|execute|steps?|method|how to)/iu;

function boundedWindow(text: string, start: number, end: number): {
  readonly value: string;
  readonly start: number;
  readonly end: number;
} {
  const windowStart = Math.max(0, start - 160);
  const windowEnd = Math.min(text.length, end + 160);
  return { value: text.slice(windowStart, windowEnd), start: windowStart, end: windowEnd };
}

function isInsideQuotation(text: string, start: number, end: number): boolean {
  const pairs: readonly [string, string][] = [
    ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['《', '》'], ['"', '"'], ["'", "'"],
  ];
  for (const [open, close] of pairs) {
    const before = text.lastIndexOf(open, start);
    if (before < 0) continue;
    const after = text.indexOf(close, Math.max(end, before + open.length));
    if (after >= end) return true;
  }
  return false;
}

function result(
  role: ContextRole,
  confidence: number,
  suppressLexicalBlock: boolean,
  windowStart: number,
  windowEnd: number,
): ContextClassification {
  return { role, confidence, suppressLexicalBlock, windowStart, windowEnd };
}

export function classifyContextRole(
  text: string,
  range: { readonly start: number; readonly end: number } = { start: 0, end: text.length },
): ContextClassification {
  const safeStart = Math.max(0, Math.min(text.length, range.start));
  const safeEnd = Math.max(safeStart, Math.min(text.length, range.end));
  const window = boundedWindow(text, safeStart, safeEnd);
  const globallyActionable = ACTIONABLE_HARMFUL_INTENT.some((pattern) => pattern.test(text));
  if (IMMEDIATE_SELF_HARM_CONTEXT.test(text)) {
    return result('disclosure', 0.99, false, window.start, window.end);
  }
  if (globallyActionable) {
    return result('instruction', 0.96, false, window.start, window.end);
  }
  if (isInsideQuotation(text, safeStart, safeEnd)) {
    return result('quotation', 0.94, true, window.start, window.end);
  }
  if (LEGAL.test(window.value)) return result('legal', 0.92, true, window.start, window.end);
  if (NEWS.test(window.value)) return result('news', 0.88, true, window.start, window.end);
  if (RESEARCH.test(window.value)) return result('research', 0.93, true, window.start, window.end);
  if (MEDICAL.test(window.value)) return result('medical', 0.9, true, window.start, window.end);
  if (EDUCATION.test(window.value) || DEFENSIVE_FRAMING.some((pattern) => pattern.test(window.value))) {
    return result('education', 0.93, true, window.start, window.end);
  }
  if (TRANSACTION.test(window.value)) return result('transaction', 0.88, false, window.start, window.end);
  if (ENDORSEMENT.test(window.value)) return result('endorsement', 0.9, false, window.start, window.end);
  if (DISCLOSURE.test(window.value)) return result('disclosure', 0.9, false, window.start, window.end);
  if (INSTRUCTION.test(window.value)) return result('instruction', 0.82, false, window.start, window.end);
  if (NEGATED_MENTION.test(window.value)) return result('mention', 0.82, true, window.start, window.end);
  return result('mention', 0.65, false, window.start, window.end);
}

/**
 * Compatibility signal used by intent detectors. It is deliberately not a
 * whitelist: actionable intent and immediate self-harm disclosures always win.
 */
export function isDefensiveEducationalContext(text: string): boolean {
  if (IMMEDIATE_SELF_HARM_CONTEXT.test(text)) return false;
  if (ACTIONABLE_HARMFUL_INTENT.some((pattern) => pattern.test(text))) return false;
  return classifyContextRole(text).suppressLexicalBlock;
}
