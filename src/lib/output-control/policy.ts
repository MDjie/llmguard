import type { GuardAction, GuardRequest } from '@guardllm/contracts';

export const OUTPUT_CONTROL_POLICY_VERSION = 'output-control-1.0.0';
export const DEFAULT_LEGAL_DISCLAIMER_VERSION = 'insurance-cn-1.0.0';

export interface OutputPolicyContext {
  readonly locale: string;
  readonly jurisdiction: string;
  readonly industry: string;
  readonly businessLine: string;
  readonly policyVersion: string;
  readonly legalDisclaimerVersion: string;
}

export const OUTPUT_ACTION_OVERRIDES: Readonly<Record<string, GuardAction>> = {
  'output.political.contextual': 'WARN',
  'output.political.position_inducement': 'REQUIRE_REVIEW',
  'output.political.fabricated_authority': 'REQUIRE_REVIEW',
  'output.political.rumor_as_fact': 'SAFE_RESPONSE',
  'output.sexual.contextual': 'WARN',
  'output.sexual.low_vulgar': 'SAFE_RESPONSE',
  'output.sexual.explicit_adult': 'BLOCK',
  'output.sexual.exploitation': 'BLOCK',
  'output.sexual.minor': 'BLOCK',
  'output.illegal.contextual': 'WARN',
  'output.illegal.actionable': 'BLOCK',
  'output.illegal.violence_hate': 'BLOCK',
  'output.illegal.self_harm_method': 'BLOCK',
  'output.illegal.fraud': 'BLOCK',
  'output.credential.secret': 'BLOCK',
  'output.privacy.name': 'MASK',
  'output.privacy.mobile': 'MASK',
  'output.privacy.email': 'MASK',
  'output.privacy.identity': 'MASK',
  'output.privacy.passport': 'MASK',
  'output.privacy.address': 'MASK',
  'output.privacy.customer_number': 'MASK',
  'output.privacy.policy_number': 'MASK',
  'output.privacy.claim_number': 'MASK',
  'output.privacy.beneficiary': 'MASK',
  'output.privacy.health': 'MASK',
  'output.privacy.medical': 'MASK',
  'output.privacy.underwriting': 'MASK',
  'output.privacy.bank_card': 'MASK',
  'output.privacy.account_balance': 'MASK',
  'output.privacy.income': 'MASK',
  'output.privacy.credit': 'MASK',
  'output.privacy.payment': 'MASK',
  'output.internal.pricing': 'MASK',
  'output.internal.unreleased_product': 'MASK',
  'output.internal.rule': 'MASK',
  'output.internal.architecture': 'MASK',
  'output.internal.staff': 'MASK',
  'output.internal.system_prompt': 'BLOCK',
  'output.insurance.contextual': 'WARN',
  'output.insurance.guaranteed_return': 'REWRITE',
  'output.insurance.claim_commitment': 'REWRITE',
  'output.insurance.exclusion_minimization': 'REWRITE',
  'output.insurance.waiting_period_minimization': 'REWRITE',
  'output.insurance.health_disclosure_evasion': 'REWRITE',
  'output.insurance.fake_regulatory_endorsement': 'REWRITE',
  'output.insurance.high_pressure': 'SAFE_RESPONSE',
  'output.insurance.no_suitability': 'REQUIRE_REVIEW',
  'output.insurance.individual_promise': 'REWRITE',
  'output.insurance.material_inconsistency': 'REQUIRE_REVIEW',
};

export const OUTPUT_ACTION_OVERRIDE_THRESHOLDS: Readonly<Record<string, number>> =
  Object.fromEntries(Object.keys(OUTPUT_ACTION_OVERRIDES).map((riskType) => [riskType, 0.5]));

export const OUTPUT_REDLINES = new Set<string>([
  'output.sexual.explicit_adult',
  'output.sexual.exploitation',
  'output.sexual.minor',
  'output.illegal.actionable',
  'output.illegal.violence_hate',
  'output.illegal.self_harm_method',
  'output.illegal.fraud',
  'output.credential.secret',
  'output.internal.system_prompt',
]);

export function isOutputDirection(direction: GuardRequest['context']['direction']): boolean {
  return direction === 'OUTPUT_COMPLETE' || direction === 'OUTPUT_CHUNK' || direction === 'TOOL_RESULT';
}

export function resolveOutputPolicyContext(request: GuardRequest): OutputPolicyContext {
  return {
    locale: request.context.locale?.trim() || 'zh-CN',
    jurisdiction: request.context.jurisdiction?.trim() || 'global',
    industry: request.context.industry?.trim() || 'general',
    businessLine: request.context.businessLine?.trim() || 'general',
    policyVersion: OUTPUT_CONTROL_POLICY_VERSION,
    legalDisclaimerVersion: request.context.legalDisclaimerVersion?.trim() ||
      DEFAULT_LEGAL_DISCLAIMER_VERSION,
  };
}

export function isOutputRedline(riskType: string): boolean {
  return OUTPUT_REDLINES.has(riskType);
}
