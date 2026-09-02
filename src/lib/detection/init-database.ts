/**
 * 数据库初始化脚本
 * 将16个内置检测维度和规则写入数据库
 */

import { getSupabaseClient } from '@/storage/database/supabase-client';
import { db } from '@/lib/db';
import { policyProfiles, policyDimensionConfig, detectionDimensions } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';

// 延迟初始化 Supabase 客户端，避免构建时环境变量缺失
let _client: ReturnType<typeof getSupabaseClient> | null = null;
function getClient() {
  if (!_client) {
    _client = getSupabaseClient();
  }
  return _client;
}

// 16个检测维度数据
const DIMENSIONS_DATA = [
  {
    id: '550e8400-e29b-41d4-a716-446655440001',
    code: 'prompt_injection',
    name: '提示词注入',
    description: '检测用户输入中是否存在试图操纵模型行为的提示词注入攻击',
    category: 'security',
    weight: 1.0,
    priority: 100,
    enabled: true,
    is_system: true,
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440002',
    code: 'pii_leak',
    name: 'PII泄露',
    description: '检测文本中是否包含个人隐私信息、身份信息、联系方式等敏感信息',
    category: 'privacy',
    weight: 1.0,
    priority: 100,
    enabled: true,
    is_system: true,
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440003',
    code: 'malicious_code',
    name: '恶意代码',
    description: '检测是否请求生成恶意代码、木马、后门、远程控制等危险内容',
    category: 'security',
    weight: 1.0,
    priority: 100,
    enabled: true,
    is_system: true,
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440004',
    code: 'violence_hate',
    name: '暴力仇恨',
    description: '检测暴力威胁、仇恨言论、人身攻击、煽动伤害等内容',
    category: 'content',
    weight: 0.9,
    priority: 100,
    enabled: true,
    is_system: true,
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440005',
    code: 'illegal_content',
    name: '非法内容',
    description: '检测违法交易、诈骗、黑灰产、非法入侵等违法内容',
    category: 'content',
    weight: 1.0,
    priority: 100,
    enabled: true,
    is_system: true,
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440006',
    code: 'ad_detection',
    name: '广告引流',
    description: '检测营销广告、联系方式引流、群聊引流、二维码推广等内容',
    category: 'spam',
    weight: 0.7,
    priority: 90,
    enabled: true,
    is_system: true,
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440007',
    code: 'spam_detection',
    name: '垃圾信息',
    description: '检测重复灌水、无意义内容、刷屏、批量模板化垃圾信息',
    category: 'spam',
    weight: 0.6,
    priority: 80,
    enabled: true,
    is_system: true,
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440008',
    code: 'sensitive_compliance',
    name: '敏感合规',
    description: '检测可能涉及平台合规、公共安全、敏感议题的内容',
    category: 'compliance',
    weight: 0.8,
    priority: 90,
    enabled: true,
    is_system: true,
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440009',
    code: 'adult_content',
    name: '色情低俗',
    description: '检测色情、低俗、露骨性内容、未成年人相关性内容',
    category: 'content',
    weight: 0.9,
    priority: 100,
    enabled: true,
    is_system: true,
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440010',
    code: 'self_harm',
    name: '自伤自杀',
    description: '检测自伤、自杀、求助、诱导自伤等高风险内容',
    category: 'safety',
    weight: 1.0,
    priority: 100,
    enabled: true,
    is_system: true,
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440011',
    code: 'credential_secret_leak',
    name: '密钥凭证泄露',
    description: '检测 API Key、Token、Secret、Access Key 等敏感凭证泄露',
    category: 'privacy',
    weight: 0.9,
    priority: 95,
    enabled: true,
    is_system: true,
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440012',
    code: 'fraud_scam',
    name: '诈骗欺诈',
    description: '检测诈骗话术、钓鱼链接、冒充客服、虚假投资等欺诈内容',
    category: 'content',
    weight: 1.0,
    priority: 100,
    enabled: true,
    is_system: true,
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440013',
    code: 'misinformation',
    name: '虚假信息',
    description: '检测虚假新闻、谣言传播、高风险医疗建议等误导性内容',
    category: 'content',
    weight: 0.8,
    priority: 85,
    enabled: true,
    is_system: true,
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440014',
    code: 'copyright_risk',
    name: '版权风险',
    description: '检测侵权内容、盗版资源传播等版权风险内容',
    category: 'compliance',
    weight: 0.7,
    priority: 80,
    enabled: true,
    is_system: true,
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440015',
    code: 'business_sensitive',
    name: '企业敏感信息',
    description: '检测企业内部信息、商业机密、内部代码库等敏感信息泄露',
    category: 'privacy',
    weight: 0.9,
    priority: 90,
    enabled: true,
    is_system: true,
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440016',
    code: 'output_leak',
    name: '输出泄露',
    description: '检测模型输出中是否泄露系统指令、内部信息等',
    category: 'security',
    weight: 0.8,
    priority: 85,
    enabled: true,
    is_system: true,
  },
];

// 规则数据 - 每个维度的规则
const RULES_DATA: Array<{
  dimension_code: string;
  rules: Array<{
    name: string;
    type: 'keyword' | 'regex';
    pattern: string;
    match_type: 'contains' | 'regex';
    score: number;
    confidence: number;
    priority: number;
    description: string;
  }>;
}> = [
  // 提示词注入规则
  {
    dimension_code: 'prompt_injection',
    rules: [
      { name: '忽略指令', type: 'keyword', pattern: '忽略之前的指令', match_type: 'contains', score: 90, confidence: 0.9, priority: 100, description: '忽略指令关键词' },
      { name: '忽略所有规则', type: 'keyword', pattern: '忽略所有规则', match_type: 'contains', score: 90, confidence: 0.9, priority: 100, description: '忽略规则关键词' },
      { name: '系统提示词', type: 'keyword', pattern: '系统提示词', match_type: 'contains', score: 95, confidence: 0.9, priority: 100, description: '系统提示词探测' },
      { name: 'system prompt', type: 'keyword', pattern: 'system prompt', match_type: 'contains', score: 95, confidence: 0.9, priority: 100, description: '系统提示词探测英文' },
      { name: '忽略', type: 'keyword', pattern: '忽略', match_type: 'contains', score: 60, confidence: 0.8, priority: 80, description: '忽略关键词' },
      { name: '忽略之前', type: 'keyword', pattern: '忽略之前', match_type: 'contains', score: 85, confidence: 0.85, priority: 90, description: '忽略之前关键词' },
      { name: '越狱', type: 'keyword', pattern: '越狱', match_type: 'contains', score: 90, confidence: 0.85, priority: 95, description: '越狱关键词' },
      { name: 'DAN', type: 'keyword', pattern: 'DAN', match_type: 'contains', score: 85, confidence: 0.85, priority: 90, description: 'DAN越狱' },
      { name: '开发者模式', type: 'keyword', pattern: '开发者模式', match_type: 'contains', score: 85, confidence: 0.85, priority: 90, description: '开发者模式越狱' },
      { name: '无限制模式', type: 'keyword', pattern: '无限制模式', match_type: 'contains', score: 85, confidence: 0.85, priority: 90, description: '无限制模式' },
      { name: '扮演', type: 'keyword', pattern: '扮演', match_type: 'contains', score: 50, confidence: 0.7, priority: 70, description: '扮演关键词' },
      { name: '绕过限制', type: 'keyword', pattern: '绕过限制', match_type: 'contains', score: 90, confidence: 0.9, priority: 100, description: '绕过限制关键词' },
      { name: '输出规则', type: 'regex', pattern: '(输出|泄露|告诉我).*系统提示词', match_type: 'regex', score: 95, confidence: 0.9, priority: 100, description: '输出系统提示词' },
    ],
  },
  // PII泄露规则
  {
    dimension_code: 'pii_leak',
    rules: [
      { name: '手机号', type: 'regex', pattern: '1[3-9]\\d{9}', match_type: 'regex', score: 80, confidence: 0.9, priority: 100, description: '手机号正则' },
      { name: '身份证号', type: 'regex', pattern: '\\d{17}[\\dXx]', match_type: 'regex', score: 90, confidence: 0.9, priority: 100, description: '身份证号正则' },
      { name: '银行卡号', type: 'regex', pattern: '\\b\\d{16,19}\\b', match_type: 'regex', score: 85, confidence: 0.8, priority: 90, description: '银行卡号正则' },
      { name: '邮箱', type: 'regex', pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', match_type: 'regex', score: 60, confidence: 0.8, priority: 80, description: '邮箱正则' },
      { name: '手机号关键词', type: 'keyword', pattern: '手机号', match_type: 'contains', score: 70, confidence: 0.75, priority: 85, description: '手机号关键词' },
      { name: '身份证号关键词', type: 'keyword', pattern: '身份证号', match_type: 'contains', score: 70, confidence: 0.75, priority: 85, description: '身份证号关键词' },
      { name: '银行卡号关键词', type: 'keyword', pattern: '银行卡号', match_type: 'contains', score: 75, confidence: 0.75, priority: 85, description: '银行卡号关键词' },
      { name: '家庭住址', type: 'keyword', pattern: '家庭住址', match_type: 'contains', score: 70, confidence: 0.75, priority: 85, description: '家庭住址关键词' },
    ],
  },
  // 恶意代码规则
  {
    dimension_code: 'malicious_code',
    rules: [
      { name: '远程控制', type: 'keyword', pattern: '远程控制', match_type: 'contains', score: 95, confidence: 0.9, priority: 100, description: '远程控制关键词' },
      { name: '木马', type: 'keyword', pattern: '木马', match_type: 'contains', score: 95, confidence: 0.9, priority: 100, description: '木马关键词' },
      { name: '后门', type: 'keyword', pattern: '后门', match_type: 'contains', score: 95, confidence: 0.9, priority: 100, description: '后门关键词' },
      { name: '获取文件', type: 'keyword', pattern: '获取文件', match_type: 'contains', score: 90, confidence: 0.85, priority: 95, description: '获取文件关键词' },
      { name: '窃取密码', type: 'keyword', pattern: '窃取密码', match_type: 'contains', score: 95, confidence: 0.9, priority: 100, description: '窃取密码关键词' },
      { name: '反弹shell', type: 'keyword', pattern: '反弹shell', match_type: 'contains', score: 90, confidence: 0.85, priority: 95, description: '反弹shell关键词' },
      { name: '免杀', type: 'keyword', pattern: '免杀', match_type: 'contains', score: 90, confidence: 0.85, priority: 95, description: '免杀关键词' },
      { name: '入侵', type: 'keyword', pattern: '入侵', match_type: 'contains', score: 85, confidence: 0.85, priority: 90, description: '入侵关键词' },
      { name: '控制他人电脑', type: 'keyword', pattern: '控制他人电脑', match_type: 'contains', score: 95, confidence: 0.9, priority: 100, description: '控制他人电脑关键词' },
    ],
  },
  // 暴力仇恨规则
  {
    dimension_code: 'violence_hate',
    rules: [
      { name: '暴力威胁', type: 'keyword', pattern: '暴力威胁', match_type: 'contains', score: 90, confidence: 0.85, priority: 100, description: '暴力威胁关键词' },
      { name: '杀人', type: 'keyword', pattern: '杀人', match_type: 'contains', score: 95, confidence: 0.9, priority: 100, description: '杀人关键词' },
      { name: '去死', type: 'keyword', pattern: '去死', match_type: 'contains', score: 85, confidence: 0.8, priority: 90, description: '去死关键词' },
      { name: '仇恨', type: 'keyword', pattern: '仇恨', match_type: 'contains', score: 80, confidence: 0.8, priority: 85, description: '仇恨关键词' },
    ],
  },
  // 非法内容规则
  {
    dimension_code: 'illegal_content',
    rules: [
      { name: '买卖账号', type: 'keyword', pattern: '买卖账号', match_type: 'contains', score: 90, confidence: 0.85, priority: 100, description: '买卖账号关键词' },
      { name: '洗钱', type: 'keyword', pattern: '洗钱', match_type: 'contains', score: 95, confidence: 0.9, priority: 100, description: '洗钱关键词' },
      { name: '黑产', type: 'keyword', pattern: '黑产', match_type: 'contains', score: 90, confidence: 0.85, priority: 95, description: '黑产关键词' },
      { name: '诈骗', type: 'keyword', pattern: '诈骗', match_type: 'contains', score: 90, confidence: 0.85, priority: 95, description: '诈骗关键词' },
      { name: '绕过实名', type: 'keyword', pattern: '绕过实名', match_type: 'contains', score: 85, confidence: 0.8, priority: 90, description: '绕过实名关键词' },
    ],
  },
  // 广告引流规则
  {
    dimension_code: 'ad_detection',
    rules: [
      { name: '加微信', type: 'keyword', pattern: '加微信', match_type: 'contains', score: 80, confidence: 0.8, priority: 90, description: '加微信引流' },
      { name: '限时优惠', type: 'keyword', pattern: '限时优惠', match_type: 'contains', score: 70, confidence: 0.8, priority: 80, description: '限时优惠广告' },
      { name: '免费领取', type: 'keyword', pattern: '免费领取', match_type: 'contains', score: 70, confidence: 0.8, priority: 80, description: '免费领取广告' },
      { name: '扫码', type: 'keyword', pattern: '扫码', match_type: 'contains', score: 75, confidence: 0.75, priority: 85, description: '扫码关键词' },
      { name: '加群', type: 'keyword', pattern: '加群', match_type: 'contains', score: 80, confidence: 0.8, priority: 90, description: '加群引流' },
    ],
  },
  // 垃圾信息规则
  {
    dimension_code: 'spam_detection',
    rules: [
      { name: '重复字符', type: 'regex', pattern: '(.)\\1{8,}', match_type: 'regex', score: 70, confidence: 0.8, priority: 80, description: '重复字符检测' },
      { name: '顶顶顶', type: 'keyword', pattern: '顶顶顶', match_type: 'contains', score: 50, confidence: 0.6, priority: 60, description: '灌水关键词' },
      { name: '刷屏', type: 'keyword', pattern: '刷屏', match_type: 'contains', score: 60, confidence: 0.7, priority: 70, description: '刷屏关键词' },
    ],
  },
  // 敏感合规规则
  {
    dimension_code: 'sensitive_compliance',
    rules: [
      { name: '绕过监管', type: 'keyword', pattern: '绕过监管', match_type: 'contains', score: 85, confidence: 0.8, priority: 90, description: '绕过监管关键词' },
      { name: '水军', type: 'keyword', pattern: '水军', match_type: 'contains', score: 75, confidence: 0.75, priority: 80, description: '水军关键词' },
      { name: '控评', type: 'keyword', pattern: '控评', match_type: 'contains', score: 75, confidence: 0.75, priority: 80, description: '控评关键词' },
    ],
  },
  // 色情低俗规则
  {
    dimension_code: 'adult_content',
    rules: [
      { name: '裸聊', type: 'keyword', pattern: '裸聊', match_type: 'contains', score: 90, confidence: 0.85, priority: 100, description: '裸聊关键词' },
      { name: '色情', type: 'keyword', pattern: '色情', match_type: 'contains', score: 95, confidence: 0.9, priority: 100, description: '色情关键词' },
      { name: '约炮', type: 'keyword', pattern: '约炮', match_type: 'contains', score: 90, confidence: 0.85, priority: 95, description: '约炮关键词' },
    ],
  },
  // 自伤自杀规则
  {
    dimension_code: 'self_harm',
    rules: [
      { name: '自杀', type: 'keyword', pattern: '自杀', match_type: 'contains', score: 95, confidence: 0.9, priority: 100, description: '自杀关键词' },
      { name: '不想活了', type: 'keyword', pattern: '不想活了', match_type: 'contains', score: 90, confidence: 0.85, priority: 100, description: '不想活了关键词' },
      { name: '结束生命', type: 'keyword', pattern: '结束生命', match_type: 'contains', score: 95, confidence: 0.9, priority: 100, description: '结束生命关键词' },
      { name: '割腕', type: 'keyword', pattern: '割腕', match_type: 'contains', score: 95, confidence: 0.9, priority: 100, description: '割腕关键词' },
    ],
  },
  // 密钥凭证泄露规则
  {
    dimension_code: 'credential_secret_leak',
    rules: [
      { name: 'OpenAI Key', type: 'regex', pattern: 'sk-[A-Za-z0-9_-]{20,}', match_type: 'regex', score: 95, confidence: 0.9, priority: 100, description: 'OpenAI API Key' },
      { name: 'api_key', type: 'keyword', pattern: 'api_key', match_type: 'contains', score: 80, confidence: 0.8, priority: 90, description: 'api_key关键词' },
      { name: 'secret_key', type: 'keyword', pattern: 'secret_key', match_type: 'contains', score: 80, confidence: 0.8, priority: 90, description: 'secret_key关键词' },
      { name: 'access_token', type: 'keyword', pattern: 'access_token', match_type: 'contains', score: 85, confidence: 0.85, priority: 95, description: 'access_token关键词' },
    ],
  },
  // 诈骗欺诈规则
  {
    dimension_code: 'fraud_scam',
    rules: [
      { name: '恭喜中奖', type: 'keyword', pattern: '恭喜中奖', match_type: 'contains', score: 90, confidence: 0.85, priority: 100, description: '恭喜中奖诈骗' },
      { name: '冒充客服', type: 'keyword', pattern: '冒充客服', match_type: 'contains', score: 85, confidence: 0.8, priority: 95, description: '冒充客服诈骗' },
      { name: '钓鱼链接', type: 'keyword', pattern: '钓鱼链接', match_type: 'contains', score: 90, confidence: 0.85, priority: 100, description: '钓鱼链接诈骗' },
      { name: '稳赚不赔', type: 'keyword', pattern: '稳赚不赔', match_type: 'contains', score: 85, confidence: 0.8, priority: 95, description: '稳赚不赔诈骗' },
      { name: '内幕消息', type: 'keyword', pattern: '内幕消息', match_type: 'contains', score: 80, confidence: 0.75, priority: 90, description: '内幕消息诈骗' },
    ],
  },
  // 虚假信息规则
  {
    dimension_code: 'misinformation',
    rules: [
      { name: '谣言', type: 'keyword', pattern: '谣言', match_type: 'contains', score: 75, confidence: 0.75, priority: 80, description: '谣言关键词' },
      { name: '虚假新闻', type: 'keyword', pattern: '虚假新闻', match_type: 'contains', score: 80, confidence: 0.8, priority: 85, description: '虚假新闻关键词' },
    ],
  },
  // 版权风险规则
  {
    dimension_code: 'copyright_risk',
    rules: [
      { name: '盗版', type: 'keyword', pattern: '盗版', match_type: 'contains', score: 80, confidence: 0.8, priority: 90, description: '盗版关键词' },
      { name: '侵权', type: 'keyword', pattern: '侵权', match_type: 'contains', score: 75, confidence: 0.75, priority: 85, description: '侵权关键词' },
    ],
  },
  // 企业敏感信息规则
  {
    dimension_code: 'business_sensitive',
    rules: [
      { name: '商业机密', type: 'keyword', pattern: '商业机密', match_type: 'contains', score: 90, confidence: 0.85, priority: 95, description: '商业机密关键词' },
      { name: '内部资料', type: 'keyword', pattern: '内部资料', match_type: 'contains', score: 85, confidence: 0.8, priority: 90, description: '内部资料关键词' },
      { name: '机密文件', type: 'keyword', pattern: '机密文件', match_type: 'contains', score: 90, confidence: 0.85, priority: 95, description: '机密文件关键词' },
    ],
  },
  // 输出泄露规则
  {
    dimension_code: 'output_leak',
    rules: [
      { name: '系统指令', type: 'keyword', pattern: '系统指令', match_type: 'contains', score: 85, confidence: 0.85, priority: 90, description: '系统指令关键词' },
      { name: '内部信息', type: 'keyword', pattern: '内部信息', match_type: 'contains', score: 80, confidence: 0.8, priority: 85, description: '内部信息关键词' },
    ],
  },
];

// 默认策略配置
const DEFAULT_POLICY = {
  id: 'policy-default-001',
  name: 'default',
  description: '默认安全策略',
  is_default: true,
  is_active: true,
  version: 1,
};

// 白名单种子数据
const WHITELIST_DATA = [
  // === 安全教育白名单 ===
  { pattern: '如何防御', description: '安全教育：防御' },
  { pattern: '如何防范', description: '安全教育：防范' },
  { pattern: '如何识别', description: '安全教育：识别' },
  { pattern: '如何修复', description: '安全教育：修复' },
  { pattern: '漏洞修复', description: '安全教育：漏洞修复' },
  { pattern: '安全加固', description: '安全教育：加固' },
  { pattern: '安全检测', description: '安全教育：检测' },
  { pattern: '安全培训', description: '安全教育：培训' },
  { pattern: '安全意识', description: '安全教育：意识' },
  { pattern: '应急处置', description: '安全教育：应急' },
  { pattern: '防御SQL注入', description: '安全教育：SQL注入防御' },
  { pattern: '防御XSS', description: '安全教育：XSS防御' },
  { pattern: '识别钓鱼邮件', description: '安全教育：钓鱼识别' },
  // === PII示例白名单 ===
  { pattern: '示例手机号', description: 'PII示例：手机号' },
  { pattern: '测试手机号', description: 'PII示例：测试号' },
  { pattern: '13800000000', description: 'PII示例：测试号段' },
  { pattern: '12345678901', description: 'PII示例：测试号段' },
  { pattern: '110101199001010000', description: 'PII示例：测试身份证' },
  // === 广告误报白名单 ===
  { pattern: '广告检测', description: '广告误报：检测' },
  { pattern: '反广告', description: '广告误报：反广告' },
  { pattern: '广告风险分析', description: '广告误报：分析' },
  { pattern: '营销内容识别', description: '广告误报：识别' },
  { pattern: '垃圾信息治理', description: '广告误报：治理' },
  // === 安全研究白名单 ===
  { pattern: '安全研究', description: '安全研究' },
  { pattern: '渗透测试', description: '渗透测试授权' },
  { pattern: '漏洞挖掘', description: '漏洞挖掘授权' },
];

/**
 * 检查数据库是否已初始化（检查是否所有16个系统维度都存在）
 */
export async function checkDatabaseInitialized(): Promise<boolean> {
  try {
    const client = getClient();
    // 获取所有系统维度
    const { data, error } = await client
      .from('detection_dimensions')
      .select('code')
      .eq('is_system', true);

    if (error) {
      console.error('检查数据库初始化状态失败:', error);
      return false;
    }

    // 检查是否所有16个维度都存在
    const expectedCodes = DIMENSIONS_DATA.map(d => d.code);
    const existingCodes = (data || []).map(d => d.code);
    const missingCodes = expectedCodes.filter(code => !existingCodes.includes(code));

    if (missingCodes.length > 0) {
      console.log('缺失的系统维度:', missingCodes);
      return false;
    }

    return true;
  } catch (error) {
    console.error('检查数据库初始化状态失败:', error);
    return false;
  }
}

/**
 * 初始化数据库
 */
export async function initializeDatabase(): Promise<{
  success: boolean;
  message: string;
  dimensions: number;
  rules: number;
  whitelist: number;
}> {
  try {
    const client = getClient();
    let dimensionsCount = 0;
    let rulesCount = 0;
    let whitelistCount = 0;

    // 1. 获取已存在的系统维度
    const { data: existingDimensions } = await client
      .from('detection_dimensions')
      .select('code')
      .eq('is_system', true);

    const existingCodes = (existingDimensions || []).map(d => d.code);

    // 2. 插入缺失的维度数据
    const missingDimensions = DIMENSIONS_DATA.filter(d => !existingCodes.includes(d.code));

    for (const dimension of missingDimensions) {
      const { error: dimError } = await client
        .from('detection_dimensions')
        .insert({
          id: dimension.id,
          code: dimension.code,
          name: dimension.name,
          description: dimension.description,
          category: dimension.category,
          weight: dimension.weight,
          priority: dimension.priority,
          enabled: dimension.enabled,
          is_system: dimension.is_system,
        });

      if (dimError) {
        console.error(`插入维度 ${dimension.code} 失败:`, dimError);
      } else {
        dimensionsCount++;
      }
    }

    // 3. 获取已存在的规则
    const { data: existingRules } = await client
      .from('detection_rules')
      .select('name');

    const existingRuleNames = (existingRules || []).map(r => r.name);

    // 4. 插入缺失的规则数据
    for (const ruleGroup of RULES_DATA) {
      // 查找维度ID
      const dimension = DIMENSIONS_DATA.find(d => d.code === ruleGroup.dimension_code);
      if (!dimension) continue;

      // 检查维度是否存在
      const { data: dimData } = await client
        .from('detection_dimensions')
        .select('id')
        .eq('code', ruleGroup.dimension_code)
        .single();

      if (!dimData) continue;

      for (const rule of ruleGroup.rules) {
        // 跳过已存在的规则
        if (existingRuleNames.includes(rule.name)) continue;

        const { error: ruleError } = await client
          .from('detection_rules')
          .insert({
            dimension_id: dimData.id,
            name: rule.name,
            type: rule.type,
            pattern: rule.pattern,
            match_type: rule.match_type,
            score: rule.score,
            confidence: rule.confidence,
            priority: rule.priority,
            description: rule.description,
            enabled: true,
            case_sensitive: false,
          });

        if (ruleError) {
          console.error(`插入规则 ${rule.name} 失败:`, ruleError);
        } else {
          rulesCount++;
        }
      }
    }

    // 5. 创建默认策略
    await client
      .from('policy_profiles')
      .upsert({
        id: DEFAULT_POLICY.id,
        name: DEFAULT_POLICY.name,
        description: DEFAULT_POLICY.description,
        is_default: DEFAULT_POLICY.is_default,
        is_active: DEFAULT_POLICY.is_active,
        version: DEFAULT_POLICY.version,
      });

    // 6. 获取已存在的白名单规则
    const { data: existingWhitelist } = await client
      .from('whitelist_rules')
      .select('pattern');

    const existingPatterns = (existingWhitelist || []).map(w => w.pattern);

    // 7. 插入缺失的白名单规则
    for (const whitelist of WHITELIST_DATA) {
      // 跳过已存在的白名单规则
      if (existingPatterns.includes(whitelist.pattern)) continue;

      const { error: wlError } = await client
        .from('whitelist_rules')
        .insert({
          policy_id: DEFAULT_POLICY.id,
          pattern: whitelist.pattern,
          match_type: 'contains',
          case_sensitive: false,
          description: whitelist.description,
          enabled: true,
        });

      if (wlError) {
        console.error(`插入白名单规则失败:`, wlError);
      } else {
        whitelistCount++;
      }
    }

    return {
      success: true,
      message: '数据库初始化成功',
      dimensions: dimensionsCount,
      rules: rulesCount,
      whitelist: whitelistCount,
    };
  } catch (error) {
    console.error('数据库初始化失败:', error);
    return {
      success: false,
      message: `初始化失败: ${error instanceof Error ? error.message : '未知错误'}`,
      dimensions: 0,
      rules: 0,
      whitelist: 0,
    };
  }
}

// 初始化默认策略
export async function initDefaultPolicy(
  scope: TenantScope,
): Promise<{ success: boolean; policyId?: string; error?: string }> {
  try {
    // 检查是否已有默认策略
    const existingPolicies = await db
      .select()
      .from(policyProfiles)
      .where(and(
        eq(policyProfiles.isDefault, true),
        scopePredicate(policyProfiles, scope),
      ))
      .limit(1);

    if (existingPolicies.length > 0) {
      return { success: true, policyId: existingPolicies[0].id };
    }

    // 创建默认策略
    const defaultPolicyId = 'policy-default-001';
    await db.insert(policyProfiles).values({
      ...scope,
      id: defaultPolicyId,
      name: '默认策略',
      description: '系统默认安全策略',
      version: 1,
      isDefault: true,
      isActive: true,
    });

    // 获取所有维度
    const dimensions = await db
      .select()
      .from(detectionDimensions)
      .where(and(
        eq(detectionDimensions.enabled, true),
        scopePredicate(detectionDimensions, scope),
      ));

    // 为每个维度创建策略配置
    const thresholdConfig: Record<string, { warn: number; block: number }> = {
      prompt_injection: { warn: 50, block: 80 },
      pii_leak: { warn: 40, block: 75 },
      malicious_code: { warn: 50, block: 80 },
      violence_hate: { warn: 50, block: 80 },
      illegal_content: { warn: 50, block: 80 },
      ad_detection: { warn: 60, block: 85 },
      spam_detection: { warn: 60, block: 85 },
      sensitive_compliance: { warn: 60, block: 85 },
      adult_content: { warn: 50, block: 80 },
      self_harm: { warn: 40, block: 70 },
      credential_secret_leak: { warn: 40, block: 75 },
      fraud_scam: { warn: 50, block: 80 },
      misinformation: { warn: 60, block: 85 },
      copyright_risk: { warn: 60, block: 85 },
      business_sensitive: { warn: 50, block: 80 },
      output_leak: { warn: 50, block: 80 },
    };

    for (const dim of dimensions) {
      const thresholds = thresholdConfig[dim.code] || { warn: 50, block: 80 };
      await db.insert(policyDimensionConfig).values({
        ...scope,
        id: `pdc-${dim.id}`,
        policyId: defaultPolicyId,
        dimensionId: dim.id,
        enabled: true,
        warnThreshold: thresholds.warn,
        blockThreshold: thresholds.block,
        autoMask: dim.code === 'pii_leak' || dim.code === 'credential_secret_leak',
        autoRewrite: false,
        actionConfig: {},
      });
    }

    return { success: true, policyId: defaultPolicyId };
  } catch (error) {
    console.error('初始化默认策略失败:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '未知错误' 
    };
  }
}
