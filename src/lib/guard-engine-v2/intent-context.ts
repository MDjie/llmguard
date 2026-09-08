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
  readonly reasonCodes: readonly string[];
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
const NEWS = /(?:新闻|报道|记者|媒体|消息称|通报|社论|\b(?:news|report(?:ed|ing)?|journalist|media|article)\b)/iu;
const LEGAL = /(?:法律|法规|法条|条例|判决|裁判文书|监管规定|合规条款|第[一二三四五六七八九十百\d]+条|\b(?:law|regulation|statute|judgment|court|legal clause|compliance clause)\b)/iu;
const RESEARCH = /(?:研究|实验|论文|评测|基准|红队|安全测试|威胁建模|\b(?:research|experiment|paper|evaluation|benchmark|red[ -]?team|security test|threat model)\b)/iu;
const EDUCATION = /(?:教育|培训|课程|教材|课堂|科普|意识提升|防范指南|安全指南|\b(?:education|training|course|textbook|classroom|awareness|prevention guide|safety guide)\b)/iu;
const MEDICAL = /(?:医疗|医学|临床|诊断|治疗|患者|医生|心理援助|危机干预|\b(?:medical|clinical|diagnosis|treatment|patient|doctor|crisis support)\b)/iu;
const TRANSACTION = /(?:购买|投保|下单|支付|转账|理赔|签约|成交|buy|purchase|insure|order|pay|transfer|claim|contract)/iu;
const ENDORSEMENT = /(?:保证|承诺|推荐|背书|肯定|绝对|稳赚|guarantee|promise|recommend|endorse|definitely|risk[- ]free)/iu;
const DISCLOSURE = /(?:泄露|披露|公开|曝光|告诉.*秘密|个人信息|病历|账号|密钥|reveal|disclose|leak|publish|personal data|medical record|credential|secret)/iu;
const INSTRUCTION = /(?:请|帮我|教我|生成|编写|执行|操作|步骤|方法|如何|怎么|please|help me|teach me|generate|write|execute|steps?|method|how to)/iu;

export interface TextRange { readonly start: number; readonly end: number }

/** The source limit is server-resolved provenance, never a text assertion. */
export function localContextWindow(text: string, range: TextRange, scope?: TextRange) {
  const lower = Math.max(0, scope?.start ?? 0, range.start - 160);
  const upper = Math.min(text.length, scope?.end ?? text.length, range.end + 160);
  const before = text.slice(lower, range.start);
  const after = text.slice(range.end, upper);
  const delimiters = /[。！？!?\n;；]|\.(?:\s|$)|\b(?:but|however|instead)\b|但是|然而|不过/giu;
  let start = lower;
  for (const match of before.matchAll(delimiters)) start = lower + (match.index ?? 0) + match[0].length;
  delimiters.lastIndex = 0;
  const next = delimiters.exec(after);
  const end = next ? range.end + next.index : upper;
  return { start, end, value: text.slice(start, end) };
}

export function quotationRanges(text: string): readonly TextRange[] {
  const closing: Readonly<Record<string,string>> = { '“':'”', '‘':'’', '「':'」', '『':'』', '《':'》', '"':'"', "'":"'" };
  const stack: Array<{ character: string; start: number }> = [];
  const ranges: TextRange[] = [];
  let escaped = false;
  for (let i=0; i<text.length; i++) {
    const character = text[i];
    if (escaped) { escaped=false; continue; }
    if (character === '\\') { escaped=true; continue; }
    if (character === "'" && /[\p{L}\p{N}]/u.test(text[i-1] ?? '') && /[\p{L}\p{N}]/u.test(text[i+1] ?? '')) continue;
    const last = stack.at(-1);
    if (last && closing[last.character] === character) {
      ranges.push({ start: last.start + 1, end: i }); stack.pop();
    } else if (closing[character] && stack.length < 32) stack.push({ character, start:i });
  }
  return ranges;
}

export function negatedOccurrence(text: string, range: TextRange): boolean {
  const prefix = text.slice(0,range.start);
  if (/(?:不得不|不是不|不要不|not\s+not|not\s+avoid)/iu.test(prefix)) return false;
  if (/(?:不要|不得|禁止|切勿|避免|反对|拒绝)\s*(?:实施|进行)?\s*$/u.test(prefix) ||
      /\b(?:do not|don't|must not|never|avoid|oppose)\s+(?:perform\s+)?$/iu.test(prefix)) return true;
  if (/(?:不要|不得|禁止|切勿|不会|不应)(?:(?:向|给)[\p{L}]{1,6})?(?:提供|索取|交出|透露|泄露|执行|实施|进行)\s*$/u.test(prefix) ||
      /\b(?:prevent|detect|stop|block)\s+(?:attackers?|criminals?)\s+(?:who|from)\s*$/iu.test(prefix)) return true;
  return /(?:预防|防止|防范|举报|检测|识别|抵制).{0,16}$/u.test(prefix) ||
    /\b(?:prevent|detect|defend against|report|mitigate|protect against)\s+(?:the\s+)?$/iu.test(prefix);
}

const ACTION_REQUEST = /(?:教我|帮我|帮助我|如何|怎么|怎样|生成|编写|制作|构造|提供|给出|执行|操作|实施|进行|学会|学着|做出|create|write|build|generate|provide|give|execute|perform|teach me|show me|how to)[\s\S]{0,64}(?:洗钱|诈骗|杀人|抢劫|盗窃|贩毒|制毒|暴力|武器|自杀|自伤|色情|攻击载荷|恶意代码|伪造|逃税|money laundering|launder money|fraud|murder|robbery|steal|drug trafficking|weapon|suicide|self[- ]harm|malware|ransomware|forge|tax evasion)/iu;

function actionable(text: string): boolean {
  return ACTION_REQUEST.test(text) || ACTIONABLE_HARMFUL_INTENT.some(pattern => pattern.test(text));
}

function result(
  role: ContextRole,
  confidence: number,
  suppressLexicalBlock: boolean,
  windowStart: number,
  windowEnd: number,
): ContextClassification {
  return { role, confidence, suppressLexicalBlock, windowStart, windowEnd, reasonCodes: [suppressLexicalBlock ? 'CONTEXT_LOCAL_' + role.toUpperCase() : 'CONTEXT_KEEP_' + role.toUpperCase()] };
}

export function classifyContextRole(
  text: string,
  range: TextRange = { start: 0, end: text.length },
  scope?: TextRange,
): ContextClassification {
  const safeStart = Math.max(0, Math.min(text.length, range.start));
  const safeEnd = Math.max(safeStart, Math.min(text.length, range.end));
  const window = localContextWindow(text, { start: safeStart, end: safeEnd }, scope);
  const localRange = { start: safeStart - window.start, end: safeEnd - window.start };
  const locallyNegated = negatedOccurrence(window.value, localRange);
  const globallyActionable = actionable(window.value);
  if (IMMEDIATE_SELF_HARM_CONTEXT.test(window.value)) {
    return result('disclosure', 0.99, false, window.start, window.end);
  }
  if (locallyNegated) return result('mention', 0.9, true, window.start, window.end);
  const quotation=quotationRanges(window.value).find(quote=>quote.start<=localRange.start&&quote.end>=localRange.end);
  if(quotation){
    const outside=window.value.slice(0,quotation.start-1)+' '+window.value.slice(quotation.end+1);
    if(!/(?:执行|照做|遵循|教我|帮我|生成|编写|提供|制作|构造|give|provide|create|write|generate|teach me|execute|perform|follow|comply)/iu.test(outside)){
      return result('quotation',0.94,true,window.start,window.end);
    }
  }
  if (globallyActionable) {
    return result('instruction', 0.96, false, window.start, window.end);
  }
  if (/(?:教我|帮我|执行|操作|teach me|execute|perform)/iu.test(window.value)) return result('instruction', 0.9, false, window.start, window.end);
  const descriptive = /(?:解释|分析|讨论|讲解|报道|提到|依据|属于|规定|判处|禁止|防范|预防|危机干预|核验|识别|检测|\b(?:explain|analy[sz]e|discuss|describe|reported|reports?|according to|prohibit|prevent|identify|detect|crisis support)\b)/iu.test(window.value);
  if (descriptive && LEGAL.test(window.value)) return result('legal', 0.92, true, window.start, window.end);
  if (descriptive && NEWS.test(window.value)) return result('news', 0.88, true, window.start, window.end);
  if (descriptive && RESEARCH.test(window.value)) return result('research', 0.93, true, window.start, window.end);
  if (descriptive && MEDICAL.test(window.value)) return result('medical', 0.9, true, window.start, window.end);
  if ((descriptive && EDUCATION.test(window.value)) || DEFENSIVE_FRAMING.some((pattern) => pattern.test(window.value))) {
    return result('education', 0.93, true, window.start, window.end);
  }
  if (TRANSACTION.test(window.value)) return result('transaction', 0.88, false, window.start, window.end);
  if (ENDORSEMENT.test(window.value)) return result('endorsement', 0.9, false, window.start, window.end);
  if (DISCLOSURE.test(window.value)) return result('disclosure', 0.9, false, window.start, window.end);
  if (INSTRUCTION.test(window.value)) return result('instruction', 0.82, false, window.start, window.end);

  return result('mention', 0.65, false, window.start, window.end);
}

/**
 * Compatibility signal used by intent detectors. It is deliberately not a
 * whitelist: actionable intent and immediate self-harm disclosures always win.
 */
export function isDefensiveEducationalContext(text: string): boolean {
  if (IMMEDIATE_SELF_HARM_CONTEXT.test(text)) return false;
  if (actionable(text)) return false;
  return classifyContextRole(text).suppressLexicalBlock;
}
