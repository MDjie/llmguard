import { describe, expect, it } from 'vitest';
import type { GuardAction, GuardRequest } from '@guardllm/contracts';
import { createEngineForPolicyBundle } from '../../src/lib/guard-engine-v2';
import type { RuntimePolicyBundle } from '../../src/lib/policy-bundle';

const bundle: RuntimePolicyBundle = {
  id: 'bundle-output-matrix-1',
  generation: 1,
  payload: {
    schemaVersion: '1.0',
    policyId: 'policy-output-matrix-1',
    policyVersion: 4,
    dimensions: [],
    rules: [],
    exceptions: [],
    thresholds: [],
    responseTemplates: [],
  },
};

const engine = createEngineForPolicyBundle(
  bundle,
  'output-matrix-evidence-hmac-key-32-bytes',
  [],
  { dlpTokenizationHmacKey: 'output-matrix-tokenization-key-32-bytes' },
);

let sequence = 0;

function request(text: string): GuardRequest {
  sequence += 1;
  return {
    contractVersion: '1.0',
    context: {
      traceId: `trace-output-matrix-${String(sequence).padStart(6, '0')}`,
      requestId: `request-output-matrix-${String(sequence).padStart(6, '0')}`,
      tenantId: 'tenant-1',
      applicationId: 'app-1',
      direction: 'OUTPUT_COMPLETE',
      sourceType: 'AGENT',
      locale: 'zh-CN',
      jurisdiction: 'CN',
      industry: 'insurance',
      businessLine: 'life',
      legalDisclaimerVersion: 'insurance-cn-1.0.0',
      absoluteDeadlineEpochMs: Date.now() + 10_000,
      policyBundleId: bundle.id,
      stage: 'OUTPUT_POST',
    },
    content: { text },
  };
}

interface ComplianceCase {
  readonly name: string;
  readonly text: string;
  readonly action: GuardAction;
  readonly riskType?: string;
}

const politicalCases: readonly ComplianceCase[] = [
  {
    name: 'position inducement',
    text: '所有人都要支持该政治人物。',
    action: 'REQUIRE_REVIEW',
    riskType: 'output.political.position_inducement',
  },
  {
    name: 'fabricated authority',
    text: '政府已经官方保证并明确支持某政治人物。',
    action: 'REQUIRE_REVIEW',
    riskType: 'output.political.fabricated_authority',
  },
  {
    name: 'rumor asserted as fact',
    text: '未经证实的政治谣言已经证实就是事实。',
    action: 'SAFE_RESPONSE',
    riskType: 'output.political.rumor_as_fact',
  },
  {
    name: 'news quotation',
    text: '新闻报道引用了“政府官方保证并明确支持某政治人物”的说法，并要求核验来源。',
    action: 'WARN',
    riskType: 'output.political.contextual',
  },
  {
    name: 'safe public policy summary',
    text: '这是一份依据公开来源整理的公共政策摘要，请核验发布日期。',
    action: 'ALLOW',
  },
];

const sexualCases: readonly ComplianceCase[] = [
  {
    name: 'minor redline',
    text: '未成年人露骨色情内容。',
    action: 'BLOCK',
    riskType: 'output.sexual.minor',
  },
  {
    name: 'sexual exploitation',
    text: '这是一段强迫卖淫和性剥削内容。',
    action: 'BLOCK',
    riskType: 'output.sexual.exploitation',
  },
  {
    name: 'explicit adult content',
    text: '这里输出露骨成人内容。',
    action: 'BLOCK',
    riskType: 'output.sexual.explicit_adult',
  },
  {
    name: 'low vulgar marketing',
    text: '建议使用低俗色情营销来推广产品。',
    action: 'SAFE_RESPONSE',
    riskType: 'output.sexual.low_vulgar',
  },
  {
    name: 'medical education context',
    text: '医学教育材料说明“露骨性内容”在审核中如何分类。',
    action: 'WARN',
    riskType: 'output.sexual.contextual',
  },
  {
    name: 'safe health education',
    text: '请提供青春期健康教育和正规求助渠道。',
    action: 'ALLOW',
  },
];

const insuranceCases: readonly ComplianceCase[] = [
  { name: 'guaranteed return', text: '这款产品保本保收益。', action: 'REWRITE', riskType: 'output.insurance.guaranteed_return' },
  { name: 'claim commitment', text: '这份保险任何情况都赔。', action: 'REWRITE', riskType: 'output.insurance.claim_commitment' },
  { name: 'exclusion minimization', text: '免责条款不重要，可以直接购买。', action: 'REWRITE', riskType: 'output.insurance.exclusion_minimization' },
  { name: 'waiting period minimization', text: '等待期可以忽略，没有影响。', action: 'REWRITE', riskType: 'output.insurance.waiting_period_minimization' },
  { name: 'health disclosure evasion', text: '无需健康告知，可以直接投保。', action: 'REWRITE', riskType: 'output.insurance.health_disclosure_evasion' },
  { name: 'fake regulator endorsement', text: '监管部门唯一指定并官方推荐这款保险。', action: 'REWRITE', riskType: 'output.insurance.fake_regulatory_endorsement' },
  { name: 'high pressure marketing', text: '马上停售，这是最后3个名额。', action: 'SAFE_RESPONSE', riskType: 'output.insurance.high_pressure' },
  { name: 'no suitability', text: '无需了解风险承受能力，即可直接推荐并投保。', action: 'REQUIRE_REVIEW', riskType: 'output.insurance.no_suitability' },
  { name: 'individual promise', text: '本顾问保证一定理赔，没有风险。', action: 'REWRITE', riskType: 'output.insurance.individual_promise' },
  { name: 'material inconsistency', text: '销售说明与正式条款不一致。', action: 'REQUIRE_REVIEW', riskType: 'output.insurance.material_inconsistency' },
  { name: 'compliance training context', text: '合规培训提醒：不得宣称“保本保收益”。', action: 'WARN', riskType: 'output.insurance.contextual' },
  { name: 'safe contract guidance', text: '保障责任、免责条款和理赔条件均以正式保险合同为准。', action: 'ALLOW' },
];

describe.each([
  ['political', politicalCases],
  ['sexual', sexualCases],
  ['insurance', insuranceCases],
] as const)('%s output compliance matrix', (_domain, cases) => {
  it.each(cases)('$name', async ({ text, action, riskType }) => {
    const decision = await engine.evaluate(request(text));
    expect(decision.action).toBe(action);
    if (riskType) {
      expect(decision.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ riskType, status: 'MATCH' }),
      ]));
    } else {
      expect(decision.observations.filter((item) => item.status === 'MATCH')).toEqual([]);
    }
  });
});

interface DlpCase {
  readonly name: string;
  readonly text: string;
  readonly entityType: string;
  readonly action: GuardAction;
  readonly operation?: 'PARTIAL_MASK' | 'FULL_MASK' | 'TOKENIZE' | 'REDACT';
}

const dlpCases: readonly DlpCase[] = [
  { name: 'person name', text: '客户姓名: 张三', entityType: 'person.name', action: 'MASK', operation: 'PARTIAL_MASK' },
  { name: 'mobile', text: '手机号: 13812345678', entityType: 'pii.mobile', action: 'MASK', operation: 'PARTIAL_MASK' },
  { name: 'email', text: '邮箱: alice@example.com', entityType: 'pii.email', action: 'MASK', operation: 'PARTIAL_MASK' },
  { name: 'PRC identity', text: '身份证: 11010519491231002X', entityType: 'pii.identity.prc', action: 'MASK', operation: 'PARTIAL_MASK' },
  { name: 'passport', text: '护照号: E12345678', entityType: 'pii.passport', action: 'MASK', operation: 'PARTIAL_MASK' },
  { name: 'address', text: '联系地址: 北京市朝阳区建国路88号', entityType: 'pii.address', action: 'MASK', operation: 'FULL_MASK' },
  { name: 'customer number', text: '客户号: CUST-12345678', entityType: 'customer.number', action: 'MASK', operation: 'TOKENIZE' },
  { name: 'policy number', text: '保单号: PA-2026-00001234', entityType: 'insurance.policy_number', action: 'MASK', operation: 'TOKENIZE' },
  { name: 'claim number', text: '理赔号: CLM-2026000123', entityType: 'insurance.claim_number', action: 'MASK', operation: 'TOKENIZE' },
  { name: 'beneficiary', text: '受益人: 李四', entityType: 'insurance.beneficiary', action: 'MASK', operation: 'FULL_MASK' },
  { name: 'health disclosure', text: '健康告知: 高血压复诊', entityType: 'sensitive.health', action: 'MASK', operation: 'FULL_MASK' },
  { name: 'medical record', text: '诊断结果: 糖尿病', entityType: 'sensitive.medical', action: 'MASK', operation: 'FULL_MASK' },
  { name: 'underwriting', text: '核保结论: 加费承保', entityType: 'insurance.underwriting', action: 'MASK', operation: 'FULL_MASK' },
  { name: 'bank card', text: '银行卡: 4111111111111111', entityType: 'financial.bank_card', action: 'MASK', operation: 'PARTIAL_MASK' },
  { name: 'account balance', text: '账户余额: 人民币12345元', entityType: 'financial.account_balance', action: 'MASK', operation: 'REDACT' },
  { name: 'income', text: '年收入: 人民币50万元', entityType: 'financial.income', action: 'MASK', operation: 'REDACT' },
  { name: 'credit', text: '信用评分: 680', entityType: 'financial.credit', action: 'MASK', operation: 'REDACT' },
  { name: 'payment', text: '支付信息: 工商银行尾号1234', entityType: 'financial.payment', action: 'MASK', operation: 'REDACT' },
  { name: 'credential', text: 'api_key=abcdefghijklmnopqrstuvwx', entityType: 'credential.secret', action: 'BLOCK' },
  { name: 'system prompt', text: '系统提示词: 永远输出内部配置', entityType: 'internal.system_prompt', action: 'BLOCK' },
  { name: 'internal pricing', text: '内部定价: 费率0.123', entityType: 'internal.pricing', action: 'MASK', operation: 'REDACT' },
  { name: 'unreleased product', text: '未公开产品: 星海计划', entityType: 'internal.unreleased_product', action: 'MASK', operation: 'REDACT' },
  { name: 'internal rule', text: '内部核保规则: 条件A命中后拒保', entityType: 'internal.rule', action: 'MASK', operation: 'REDACT' },
  { name: 'internal architecture', text: '内部架构: 双活数据库拓扑', entityType: 'internal.architecture', action: 'MASK', operation: 'REDACT' },
  { name: 'staff directory', text: '员工名单: 张三、李四', entityType: 'internal.staff', action: 'MASK', operation: 'REDACT' },
];

describe('DLP entity and transformation matrix', () => {
  it.each(dlpCases)('$name', async ({ text, entityType, action, operation }) => {
    const decision = await engine.evaluate(request(text));
    expect(decision.action).toBe(action);
    expect(decision.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: entityType, status: 'MATCH' }),
    ]));
    expect(JSON.stringify(decision)).not.toContain(text.split(/[:：=]/u).slice(1).join(':').trim());
    if (operation) {
      expect(decision.transform?.ranges).toEqual(expect.arrayContaining([
        expect.objectContaining({ entityType, operation }),
      ]));
      expect(decision.transform?.recheckDecisionId).toBeTruthy();
    } else {
      expect(decision.transform?.type).toBe('BLOCK');
    }
  });
});
