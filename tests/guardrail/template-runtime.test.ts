import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  renderResponseTemplate,
  selectResponseTemplate,
  type RuntimeResponseTemplate,
} from '../../src/lib/output-control';

const context = {
  locale: 'zh-CN',
  jurisdiction: 'CN',
  industry: 'insurance',
  businessLine: 'life',
  policyVersion: 'output-control-1.0.0',
  legalDisclaimerVersion: 'insurance-cn-1.0.0',
};

function template(overrides: Partial<RuntimeResponseTemplate> = {}): RuntimeResponseTemplate {
  const templateText = overrides.templateText ?? '请求 {{requestId}} 需要合规处理。';
  return {
    id: 'template-1',
    templateKey: 'tenant.output.safe',
    riskCategory: 'output.insurance.high_pressure',
    action: 'SAFE_RESPONSE',
    locale: 'zh-CN',
    industry: 'insurance',
    jurisdiction: 'CN',
    businessLine: 'life',
    legalDisclaimerVersion: 'insurance-cn-1.0.0',
    templateScope: 'TENANT',
    templateText,
    allowedVariables: ['requestId'],
    version: 2,
    contentHash: createHash('sha256').update(templateText).digest('hex'),
    signatureDigest: 'a'.repeat(64),
    approvedBy: 'approver-2',
    ...overrides,
  };
}

describe('signed response template runtime', () => {
  it('selects the most specific locale, industry, jurisdiction and business-line version', () => {
    const generic = template({
      id: 'generic', locale: 'und', industry: 'general', jurisdiction: 'global', businessLine: 'general', version: 9,
    });
    const exact = template({ id: 'exact', version: 2 });
    expect(selectResponseTemplate([generic, exact], {
      riskType: 'output.insurance.high_pressure', action: 'SAFE_RESPONSE', context,
    })?.id).toBe('exact');
  });

  it('renders only declared safe variables and verifies content integrity', () => {
    const result = renderResponseTemplate([template()], {
      riskType: 'output.insurance.high_pressure', action: 'SAFE_RESPONSE', context,
    }, {
      requestId: 'request-123',
      traceId: 'unused-safe-value',
    });
    expect(result).toMatchObject({ ok: true, text: '请求 request-123 需要合规处理。', templateVersion: 2 });

    expect(renderResponseTemplate([template({ contentHash: 'b'.repeat(64) })], {
      riskType: 'output.insurance.high_pressure', action: 'SAFE_RESPONSE', context,
    }, { requestId: 'request-123' })).toMatchObject({
      ok: false,
      reasonCode: 'TEMPLATE_CONTENT_DIGEST_INVALID',
    });
  });

  it('rejects forbidden secret or full-content variables', () => {
    const unsafeText = '结果 {{secret}}';
    const unsafe = template({
      templateText: unsafeText,
      allowedVariables: ['secret'],
      contentHash: createHash('sha256').update(unsafeText).digest('hex'),
    });
    expect(renderResponseTemplate([unsafe], {
      riskType: 'output.insurance.high_pressure', action: 'SAFE_RESPONSE', context,
    }, { secret: 'must-not-render' })).toMatchObject({
      ok: false,
      reasonCode: 'TEMPLATE_VARIABLE_ALLOWLIST_INVALID',
    });
  });

  it('prevents a platform redline template from weakening BLOCK', () => {
    const redline = template({
      templateScope: 'PLATFORM',
      riskCategory: 'platform.redline.credential',
      action: 'WARN',
      templateText: 'warning',
      allowedVariables: [],
      contentHash: createHash('sha256').update('warning').digest('hex'),
    });
    expect(renderResponseTemplate([redline], {
      riskType: 'platform.redline.credential', action: 'WARN', context,
    }, {})).toMatchObject({
      ok: false,
      reasonCode: 'PLATFORM_REDLINE_TEMPLATE_WEAKENED',
    });
  });
});
