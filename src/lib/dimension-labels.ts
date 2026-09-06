/**
 * 风险维度中文标签的唯一事实来源。
 * 此前同一映射在 dashboard / history 路由 / history 页面 / llm orchestrator
 * 四处各自维护并已分叉（history 页仅 5/16 项，缺失维度直接显示英文码）。
 */
export const DIMENSION_LABELS: Readonly<Record<string, string>> = {
  prompt_injection: '提示词注入',
  pii_leak: 'PII泄露',
  credential_secret_leak: '凭证泄露',
  malicious_code: '恶意代码',
  violence_hate: '暴力仇恨',
  illegal_content: '非法内容',
  spam_detection: '垃圾信息',
  ad_detection: '广告检测',
  sensitive_compliance: '敏感合规',
  adult_content: '成人内容',
  self_harm: '自残',
  fraud_scam: '欺诈诈骗',
  misinformation: '虚假信息',
  copyright_risk: '版权风险',
  business_sensitive: '商业敏感',
  output_leak: '输出泄露',
};

export function dimensionLabel(code: string): string {
  return DIMENSION_LABELS[code] ?? code;
}
