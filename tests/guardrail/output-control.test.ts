import { createHash } from 'node:crypto';
import { resolveContextEnvelopes } from '../../src/lib/context-trust';
import { describe, expect, it } from 'vitest';
import type { GuardRequest } from '@guardllm/contracts';
import { guardDecisionSchema } from '../../src/contracts/http/guard-v1';
import { createEngineForPolicyBundle } from '../../src/lib/guard-engine-v2';
import {
  applyOutputIntervention,
  PLATFORM_FIXED_SAFE_RESPONSE,
  type OutputControlFailureInput,
} from '../../src/lib/output-control';
import type { RuntimePolicyBundle } from '../../src/lib/policy-bundle';

const hmacKey = 'output-control-evidence-key-32-bytes';
const tokenizationKey = 'output-control-token-key-32-bytes!!';

function bundle(responseTemplates: NonNullable<RuntimePolicyBundle['payload']['responseTemplates']> = []): RuntimePolicyBundle {
  return {
    id: 'bundle-output-1',
    generation: 1,
    payload: {
      schemaVersion: '1.0',
      policyId: 'policy-output-1',
      policyVersion: 4,
      dimensions: [],
      rules: [],
      exceptions: [],
      thresholds: [],
      responseTemplates,
    },
  };
}

function request(text: string, requestId = 'request-output-001'): GuardRequest {
  return {
    contractVersion: '1.0',
    context: {
      traceId: 'trace-output-0000000001',
      requestId,
      tenantId: 'tenant-1',
      applicationId: 'app-1',
      direction: 'OUTPUT_COMPLETE',
      sourceType: 'AGENT',
      locale: 'zh-CN',
      jurisdiction: 'CN',
      industry: 'insurance',
      businessLine: 'life',
      legalDisclaimerVersion: 'insurance-cn-1.0.0',
      absoluteDeadlineEpochMs: Date.now() + 5_000,
      policyBundleId: 'bundle-output-1',
      stage: 'OUTPUT_POST',
    },
    content: { text },
  };
}

function engine(
  subject = bundle(),
  eventSink?: (event: OutputControlFailureInput) => void,
) {
  return createEngineForPolicyBundle(subject, hmacKey, [], {
    dlpTokenizationHmacKey: tokenizationKey,
    outputSecurityEventSink: eventSink,
  });
}

describe('independent output compliance and intervention', () => {
  it('covers S0 ALLOW and emits policy context without copying output content', async () => {
    const decision = await engine().evaluate(request('请根据正式保险合同了解保障范围。'));
    expect(decision.action).toBe('ALLOW');
    expect(decision.compliance).toEqual({
      locale: 'zh-CN',
      jurisdiction: 'CN',
      industry: 'insurance',
      businessLine: 'life',
      policyVersion: 'output-control-1.0.0',
      legalDisclaimerVersion: 'insurance-cn-1.0.0',
    });
    expect(decision).not.toHaveProperty('transformedText');
    expect(() => guardDecisionSchema.parse(decision)).not.toThrow();
  });

  it('uses S1 WARN for political material in a quoted news context', async () => {
    const decision = await engine().evaluate(request(
      '新闻报道引用了“政府官方保证并明确支持某政治人物”的说法，并要求核验来源。',
    ));
    expect(decision.action).toBe('WARN');
    expect(decision.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        detectorId: 'output-political-compliance',
        riskType: 'output.political.contextual',
        contextRole: expect.stringMatching(/quotation|news/),
        configurationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]));
  });

  it('uses S2 MASK with partial masking, full hiding and stable tokenization, then rechecks', async () => {
    const source = [
      '客户姓名: 张三',
      '手机: 13812345678',
      '保单号: PA-2026-00001234',
      '健康告知: 高血压复诊',
      '银行卡: 4111111111111111',
    ].join('\n');
    const decision = await engine().evaluate(request(source));
    expect(decision.action).toBe('MASK');
    expect(decision.transformedText).toContain('138****5678');
    expect(decision.transformedText).toContain('tok_v1_');
    expect(decision.transformedText).toContain('[已隐藏敏感数据]');
    for (const secret of ['张三', '13812345678', 'PA-2026-00001234', '高血压复诊', '4111111111111111']) {
      expect(decision.transformedText).not.toContain(secret);
      expect(JSON.stringify(decision.transform)).not.toContain(secret);
    }
    expect(new Set(decision.transform?.ranges.map((range) => range.operation))).toEqual(
      new Set(['PARTIAL_MASK', 'TOKENIZE', 'FULL_MASK']),
    );
    expect(decision.transform?.recheckDecisionId).toBeTruthy();
    expect(() => guardDecisionSchema.parse(decision)).not.toThrow();
  });

  it('uses S3 REWRITE for prohibited insurance promises and rechecks the result', async () => {
    const decision = await engine().evaluate(request('这款产品保本保收益，任何情况都赔。'));
    expect(decision.action).toBe('REWRITE');
    expect(decision.transformedText).not.toContain('保本保收益');
    expect(decision.transformedText).not.toContain('任何情况都赔');
    expect(decision.transformedText).toContain('正式合同');
    expect(decision.transform).toMatchObject({ type: 'REWRITE' });
    expect(decision.transform?.recheckDecisionId).toBeTruthy();
  });

  it('uses S4 REQUIRE_REVIEW for missing suitability assessment', async () => {
    const decision = await engine().evaluate(request(
      '无需了解年龄和风险承受能力，即可直接推荐并投保这款产品。',
    ));
    expect(decision.action).toBe('REQUIRE_REVIEW');
    expect(decision.transformedText).toContain('人工合规审核');
    expect(decision.transform).toMatchObject({
      type: 'REQUIRE_REVIEW',
      templateId: 'platform-output-require-review-v1',
      templateVersion: 1,
    });
  });

  it('uses S4 SAFE_RESPONSE for high-pressure insurance marketing', async () => {
    const decision = await engine().evaluate(request('马上停售，这是最后3个名额，今天不买就没了。'));
    expect(decision.action).toBe('SAFE_RESPONSE');
    expect(decision.transformedText).toBe(PLATFORM_FIXED_SAFE_RESPONSE);
    expect(decision.transform).toMatchObject({
      type: 'SAFE_RESPONSE',
      templateId: 'platform-output-safe-response-v1',
    });
    expect(decision.transform?.recheckDecisionId).toBeTruthy();
  });

  it.each([
    ['未成年人露骨色情内容', 'output-sexual-safety', 'output.sexual.minor'],
    ['api_key=abcdefghijklmnopqrstuvwx', 'output-credential-leak', 'output.credential.secret'],
  ])('uses S5 BLOCK for platform redline: %s', async (text, detectorId, riskType) => {
    const decision = await engine().evaluate(request(text));
    expect(decision.action).toBe('BLOCK');
    expect(decision.transformedText).toBe(PLATFORM_FIXED_SAFE_RESPONSE);
    expect(decision.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ detectorId, riskType }),
    ]));
    expect(JSON.stringify(decision)).not.toContain('abcdefghijklmnopqrstuvwx');
  });

  it('fails closed and emits sanitized evidence when a rendered rewrite fails redline recheck', async () => {
    const unsafeTemplateText = 'api_key=abcdefghijklmnopqrstuvwxyz123456';
    const events: OutputControlFailureInput[] = [];
    const subject = bundle([{
      id: 'tenant-rewrite-unsafe',
      templateKey: 'tenant.insurance.rewrite',
      riskCategory: 'output.insurance.guaranteed_return',
      action: 'REWRITE',
      locale: 'zh-CN',
      industry: 'insurance',
      templateText: unsafeTemplateText,
      allowedVariables: [],
      version: 1,
      contentHash: createHash('sha256').update(unsafeTemplateText).digest('hex'),
      signatureDigest: 'b'.repeat(64),
      approvedBy: 'independent-approver',
    }]);
    const decision = await engine(subject, (event) => events.push(event)).evaluate(
      request('这款产品保本保收益。', 'request-output-recheck-failure'),
    );
    expect(decision.action).toBe('BLOCK');
    expect(decision.transformedText).toBe(PLATFORM_FIXED_SAFE_RESPONSE);
    expect(decision.reasonCodes).toContain('OUTPUT_RECHECK_REDLINE_MATCH');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reasonCode: 'OUTPUT_RECHECK_REDLINE_MATCH' });
    expect(JSON.stringify(events)).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });
});

describe('explicit output source envelope regression', () => {
  it('rechecks the derived output instead of retaining the original content hash and bounds', async () => {
    const original = request('手机: 13812345678\n健康告知: 高血压复诊'.replace('\\n', '\n'));
    const explicit = { ...original, content: { ...original.content,
      envelopes: resolveContextEnvelopes(original, Date.now()) } };
    const result = await engine().evaluate(explicit);
    expect(result.action).toBe('MASK');
    expect(result.reasonCodes).not.toContain('OUTPUT_RECHECK_FAILED');
    expect(result.transformedText).not.toContain('13812345678');
    expect(result.transformedText).not.toContain('高血压复诊');
  });
});

describe('derived output recheck authorization and availability', () => {
  it('retains authorization on original sources without rebinding an intent to transformed content', async () => {
    const base=request('手机: 13812345678','tool-result-recheck');
    const envelopes=resolveContextEnvelopes(base,Date.now());
    const explicit:GuardRequest={...base,context:{...base.context,direction:'TOOL_RESULT'},
      content:{...base.content,envelopes},actionIntent:{
        intentId:'read-result',userGoal:'read customer record',toolName:'customer.read',
        parametersDigest:'a'.repeat(64),targetResource:'customer:synthetic',sideEffect:'READ',
        requiredPermissions:['customer:read'],supportingEnvelopeIds:[envelopes[0].envelopeId],
        dataDestinations:[],riskBudget:0.1}};
    const result=await engine().evaluate(explicit);
    expect(result.action).toBe('MASK');
    expect(result.degraded).toBe(false);
    expect(result.transform?.recheckDecisionId).toBeTruthy();
    await expect(engine().evaluate({...explicit,actionIntent:{...explicit.actionIntent!,supportingEnvelopeIds:['unknown']}}))
      .rejects.toMatchObject({code:'GRD_ACTION_INTENT_SOURCE_UNKNOWN'});
  });
  it('blocks a degraded ALLOW recheck and reports availability failure instead of malicious content', async () => {
    const source=request('手机: 13812345678','degraded-recheck');
    const clean=await engine().evaluate(request('正常说明'));
    const mask=await engine().evaluate(source);
    const result=await applyOutputIntervention(source,mask,bundle(),{
      evidenceHmacKey:hmacKey,tokenizationHmacKey:tokenizationKey,
      evaluateRecheck:async()=>({...clean,degraded:true,failMode:'DEGRADED',degradationReasons:['TEST_TIMEOUT']})});
    expect(result.action).toBe('BLOCK');
    expect(result.reasonCodes).toContain('OUTPUT_RECHECK_UNAVAILABLE');
    expect(result.reasonCodes).not.toContain('OUTPUT_RECHECK_REDLINE_MATCH');
    expect(result.degradationReasons).toContain('recheck:TEST_TIMEOUT');
    expect(result.evidenceComplete).toBe(false);
  });
});
