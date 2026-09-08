import { dimensionLabel } from '@/lib/dimension-labels';
const risks:Readonly<Record<string,string>>={
  'prompt.injection.direct':'直接提示词注入','prompt.injection.indirect':'间接提示词注入','prompt.injection.jailbreak':'越狱攻击',
  'guard_block':'安全护栏阻断','system.job_failed':'检测任务失败','system.archive_incomplete':'对话归档不完整',
  'legacy.unverified_decision':'历史检测结论待核验',
};
export const severityLabel:Readonly<Record<string,string>>={LOW:'低风险',MEDIUM:'中风险',HIGH:'高风险',CRITICAL:'严重'};
export function riskLabel(code:string):string {
  if(risks[code])return risks[code];
  const direct=dimensionLabel(code);if(direct!==code)return direct;
  if(code.startsWith('prompt.injection.'))return '提示词注入';
  if(code.startsWith('privacy.'))return '隐私泄露';
  if(code.startsWith('content.'))return '内容安全风险';
  if(code.startsWith('system.'))return '系统检测异常';
  return /[\u4e00-\u9fff]/u.test(code)?code:'其他风险';
}
export function incidentTitle(title:string,riskType:string):string {
  return title.startsWith('Blocked model interaction:')?`模型交互已阻断：${riskLabel(riskType)}`:title;
}
export function incidentText(text:string):string {
  if (/^(?:prompt|privacy|content|system)\.[a-zA-Z0-9_.-]+$/u.test(text)) return riskLabel(text);
  if(text==='The unsafe interaction was blocked and queued for security review.')return '风险交互已阻断，等待安全人员复核。';
  if(text==='Incident created')return '事件已创建';
  const keys:Record<string,string>={decision:'检测结论',inputAction:'输入处置',inputScore:'输入风险分数',outputAction:'输出处置',outputScore:'输出风险分数',maximumScore:'最高风险分数',dimensions:'风险维度',matchedRules:'命中规则',matchedRuleCount:'命中规则数',category:'告警性质',decisionAction:'检测动作',source:'来源',ruleIds:'规则标识',alertId:'告警标识'};
  const values:Record<string,string>={BLOCK:'阻断',block:'阻断',ALLOW:'允许',allow:'允许',WARN:'告警',warn:'告警',MASK:'脱敏',mask:'脱敏',REWRITE:'改写',rewrite:'改写',SAFE_RESPONSE:'安全回复',REQUIRE_REVIEW:'人工复核',SECURITY_RISK:'安全风险',UNDETERMINED:'待判定',SYSTEM_FAILURE:'系统故障'};
  try{const parsed:unknown=JSON.parse(text);if(typeof parsed!=='object'||parsed===null||Array.isArray(parsed))return text;
    return Object.entries(parsed).map(([key,value])=>`${keys[key]??key}：${Array.isArray(value)?value.map(item=>key==='dimensions'?riskLabel(String(item)):String(item)).join('、')||'无':value===null?'无':values[String(value)]??String(value)}`).join('\n');
  }catch{return text;}
}
