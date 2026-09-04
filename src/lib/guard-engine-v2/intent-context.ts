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

/**
 * Returns true only for clearly defensive, educational, research, or awareness
 * framing without an actionable harmful request. It is intentionally not a
 * whitelist: mandatory-deny rules and direct self-harm disclosures must never
 * be suppressed by this signal.
 */
export function isDefensiveEducationalContext(text: string): boolean {
  if (IMMEDIATE_SELF_HARM_CONTEXT.test(text)) return false;
  if (!DEFENSIVE_FRAMING.some((pattern) => pattern.test(text))) return false;
  return !ACTIONABLE_HARMFUL_INTENT.some((pattern) => pattern.test(text));
}
