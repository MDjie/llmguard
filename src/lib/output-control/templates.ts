import { createHash } from 'node:crypto';
import type { GuardAction } from '@guardllm/contracts';
import type { ResponseTemplateManifest } from '@/lib/policy-bundle/governance';
import type { OutputPolicyContext } from './policy';

export interface RuntimeResponseTemplate extends ResponseTemplateManifest {
  readonly jurisdiction?: string;
  readonly businessLine?: string;
  readonly legalDisclaimerVersion?: string;
  readonly templateScope?: 'PLATFORM' | 'TENANT';
}

export interface TemplateSelectionInput {
  readonly riskType: string;
  readonly action: Exclude<GuardAction, 'ALLOW' | 'MASK'>;
  readonly context: OutputPolicyContext;
}

export interface TemplateRenderResult {
  readonly ok: boolean;
  readonly text?: string;
  readonly templateId?: string;
  readonly templateVersion?: number;
  readonly reasonCode?: string;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu;
const SHA256 = /^[a-f0-9]{64}$/u;
const FORBIDDEN_VARIABLE = /(?:raw|text|content|prompt|instruction|attack|secret|password|token|credential|pii|identity|health|medical|evidence|original|input|output|payload)/iu;

export const PLATFORM_FIXED_SAFE_RESPONSE =
  '抱歉，该内容无法安全提供。请调整问题，或联系人工服务获取合规帮助。';
export const PLATFORM_REVIEW_RESPONSE =
  '该请求需要人工合规审核；在审核完成前，相关内容不会向用户展示。';

const LEGAL_DISCLAIMERS: Readonly<Record<string, string>> = {
  'insurance-cn-1.0.0':
    '保险产品的保障范围、责任免除、等待期及理赔条件以正式合同和审核结果为准；购买前请结合自身需求与风险承受能力审慎决策。',
  none: '',
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function platformTemplate(input: {
  readonly id: string;
  readonly templateKey: string;
  readonly riskCategory: string;
  readonly action: RuntimeResponseTemplate['action'];
  readonly templateText: string;
}): RuntimeResponseTemplate {
  const contentHash = sha256(input.templateText);
  return {
    ...input,
    locale: 'zh-CN',
    industry: 'general',
    jurisdiction: 'global',
    businessLine: 'general',
    legalDisclaimerVersion: 'none',
    templateScope: 'PLATFORM',
    allowedVariables: [],
    version: 1,
    contentHash,
    signatureDigest: sha256(`guardllm:platform-template:v1:${input.id}:${contentHash}`),
    approvedBy: 'guardllm-platform-security',
  };
}

export function builtInOutputResponseTemplates(): readonly RuntimeResponseTemplate[] {
  return [
    platformTemplate({
      id: 'platform-output-block-v1',
      templateKey: 'platform.output.block',
      riskCategory: '*',
      action: 'BLOCK',
      templateText: PLATFORM_FIXED_SAFE_RESPONSE,
    }),
    platformTemplate({
      id: 'platform-output-safe-response-v1',
      templateKey: 'platform.output.safe-response',
      riskCategory: '*',
      action: 'SAFE_RESPONSE',
      templateText: PLATFORM_FIXED_SAFE_RESPONSE,
    }),
    platformTemplate({
      id: 'platform-output-require-review-v1',
      templateKey: 'platform.output.require-review',
      riskCategory: '*',
      action: 'REQUIRE_REVIEW',
      templateText: PLATFORM_REVIEW_RESPONSE,
    }),
  ];
}

export function legalDisclaimer(version: string): string {
  return LEGAL_DISCLAIMERS[version] ?? LEGAL_DISCLAIMERS['insurance-cn-1.0.0'];
}

function assertRuntimeTemplate(template: RuntimeResponseTemplate): void {
  if (!SHA256.test(template.contentHash) || sha256(template.templateText) !== template.contentHash) {
    throw new Error('TEMPLATE_CONTENT_DIGEST_INVALID');
  }
  if (!SHA256.test(template.signatureDigest) || !template.approvedBy.trim()) {
    throw new Error('TEMPLATE_APPROVAL_INVALID');
  }
  if (
    new Set(template.allowedVariables).size !== template.allowedVariables.length ||
    template.allowedVariables.some((variable) =>
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(variable) || FORBIDDEN_VARIABLE.test(variable))
  ) throw new Error('TEMPLATE_VARIABLE_ALLOWLIST_INVALID');
  const placeholders = [...template.templateText.matchAll(PLACEHOLDER)].map((match) => match[1]);
  if (placeholders.some((variable) => !template.allowedVariables.includes(variable))) {
    throw new Error('TEMPLATE_VARIABLE_NOT_ALLOWED');
  }
  if (
    template.templateScope === 'PLATFORM' &&
    template.riskCategory.startsWith('platform.redline') &&
    template.action !== 'BLOCK'
  ) throw new Error('PLATFORM_REDLINE_TEMPLATE_WEAKENED');
}

function selectorScore(template: RuntimeResponseTemplate, input: TemplateSelectionInput): number {
  if (template.action !== input.action) return -1;
  const riskScore = template.riskCategory === input.riskType
    ? 32
    : input.riskType.startsWith(`${template.riskCategory}.`)
      ? 24
      : template.riskCategory === '*'
        ? 1
        : -1;
  if (riskScore < 0) return -1;
  const localeScore = template.locale === input.context.locale
    ? 16
    : template.locale === 'und' || template.locale === 'zh-CN'
      ? 2
      : -1;
  if (localeScore < 0) return -1;
  const industryScore = template.industry === input.context.industry
    ? 8
    : template.industry === 'general'
      ? 1
      : -1;
  if (industryScore < 0) return -1;
  const jurisdiction = template.jurisdiction ?? 'global';
  const jurisdictionScore = jurisdiction === input.context.jurisdiction
    ? 4
    : jurisdiction === 'global'
      ? 1
      : -1;
  if (jurisdictionScore < 0) return -1;
  const businessLine = template.businessLine ?? 'general';
  const businessScore = businessLine === input.context.businessLine
    ? 2
    : businessLine === 'general'
      ? 1
      : -1;
  return businessScore < 0 ? -1 : riskScore + localeScore + industryScore + jurisdictionScore + businessScore;
}

export function selectResponseTemplate(
  templates: readonly RuntimeResponseTemplate[],
  input: TemplateSelectionInput,
): RuntimeResponseTemplate | undefined {
  return templates
    .map((template, index) => ({ template, index, score: selectorScore(template, input) }))
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) =>
      right.score - left.score ||
      right.template.version - left.template.version ||
      left.index - right.index)[0]?.template;
}

export function renderResponseTemplate(
  templates: readonly RuntimeResponseTemplate[],
  input: TemplateSelectionInput,
  variables: Readonly<Record<string, string>>,
): TemplateRenderResult {
  const template = selectResponseTemplate(templates, input);
  if (!template) return { ok: false, reasonCode: 'TEMPLATE_NOT_FOUND' };
  try {
    assertRuntimeTemplate(template);
    for (const name of template.allowedVariables) {
      const value = variables[name];
      if (value === undefined) throw new Error('TEMPLATE_VARIABLE_MISSING');
      if (FORBIDDEN_VARIABLE.test(name) || value.length > 512 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) {
        throw new Error('TEMPLATE_VARIABLE_VALUE_INVALID');
      }
    }
    const rendered = template.templateText.replace(PLACEHOLDER, (_match, variable: string) => {
      const value = variables[variable];
      if (value === undefined) throw new Error('TEMPLATE_VARIABLE_MISSING');
      return value;
    });
    PLACEHOLDER.lastIndex = 0;
    if (PLACEHOLDER.test(rendered)) throw new Error('TEMPLATE_RENDER_INCOMPLETE');
    PLACEHOLDER.lastIndex = 0;
    return {
      ok: true,
      text: rendered,
      templateId: template.id,
      templateVersion: template.version,
    };
  } catch (error) {
    return {
      ok: false,
      templateId: template.id,
      templateVersion: template.version,
      reasonCode: error instanceof Error ? error.message : 'TEMPLATE_RENDER_FAILED',
    };
  }
}
