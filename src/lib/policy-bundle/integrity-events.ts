import { randomUUID } from 'node:crypto';
import {
  appendOperationalSecurityEvent,
  operationalEventDigest,
  type OperationalEventDomain,
  type OperationalSecurityEvent,
} from '@/lib/operations';
import { observeSafetyAlert, type SafetyAlertType } from '@/lib/observability/metrics';
import type { TenantScope } from '@/lib/tenancy';

export type PolicyIntegrityFailure =
  | 'AUDIT_CHAIN_BREAK'
  | 'POLICY_BUNDLE_MISSING'
  | 'POLICY_DIGEST_MISMATCH'
  | 'POLICY_SIGNATURE_INVALID'
  | 'POLICY_PUBLIC_KEY_MISMATCH'
  | 'MANDATORY_DENY_BYPASS'
  | 'STREAM_COMMIT_GATE_FAILURE'
  | 'TEMPLATE_RECHECK_FAILED';

const failureProfile: Readonly<Record<PolicyIntegrityFailure, {
  readonly domain: OperationalEventDomain;
  readonly eventType: string;
  readonly severity: 'HIGH' | 'CRITICAL';
  readonly action: string;
}>> = {
  AUDIT_CHAIN_BREAK: {
    domain: 'AUDIT',
    eventType: 'AUDIT.CHAIN.INTEGRITY_FAILURE',
    severity: 'CRITICAL',
    action: 'QUARANTINE_AUDIT_PARTITION',
  },
  POLICY_BUNDLE_MISSING: {
    domain: 'RUNTIME',
    eventType: 'POLICY.BUNDLE.MISSING',
    severity: 'CRITICAL',
    action: 'FAIL_CLOSED',
  },
  POLICY_DIGEST_MISMATCH: {
    domain: 'RUNTIME',
    eventType: 'POLICY.BUNDLE.INTEGRITY_FAILURE',
    severity: 'CRITICAL',
    action: 'FAIL_CLOSED',
  },
  POLICY_SIGNATURE_INVALID: {
    domain: 'RUNTIME',
    eventType: 'POLICY.BUNDLE.SIGNATURE_INVALID',
    severity: 'CRITICAL',
    action: 'FAIL_CLOSED',
  },
  POLICY_PUBLIC_KEY_MISMATCH: {
    domain: 'RUNTIME',
    eventType: 'POLICY.PUBLIC_KEY.MISMATCH',
    severity: 'CRITICAL',
    action: 'FAIL_CLOSED',
  },
  MANDATORY_DENY_BYPASS: {
    domain: 'RUNTIME',
    eventType: 'POLICY.MANDATORY_DENY.BYPASS',
    severity: 'CRITICAL',
    action: 'FAIL_CLOSED',
  },
  STREAM_COMMIT_GATE_FAILURE: {
    domain: 'RUNTIME',
    eventType: 'POLICY.STREAM_COMMIT_GATE.FAILURE',
    severity: 'CRITICAL',
    action: 'ABORT_STREAM',
  },
  TEMPLATE_RECHECK_FAILED: {
    domain: 'RUNTIME',
    eventType: 'POLICY.TEMPLATE.RECHECK_FAILURE',
    severity: 'HIGH',
    action: 'FALLBACK_SAFE_RESPONSE',
  },
};

export interface PolicyIntegrityFailureInput {
  readonly failure: PolicyIntegrityFailure;
  readonly scope: TenantScope;
  readonly principalId?: string;
  readonly bundleId?: string;
  readonly templateId?: string;
  readonly traceId?: string;
  readonly requestId?: string;
  readonly detailCode: string;
  readonly generation?: number;
}

export function policyIntegritySecurityEvent(
  input: PolicyIntegrityFailureInput,
  dependencies: {
    readonly id?: () => string;
    readonly now?: () => Date;
  } = {},
): OperationalSecurityEvent {
  const profile = failureProfile[input.failure];
  const attributes: Record<string, string | number | boolean | null> = {
    failure: input.failure,
    detailCode: input.detailCode,
    bundleId: input.bundleId ?? null,
    templateId: input.templateId ?? null,
    generation: input.generation ?? null,
    rawContentStored: false,
  };
  return {
    id: dependencies.id?.() ?? randomUUID(),
    domain: profile.domain,
    eventType: profile.eventType,
    severity: profile.severity,
    outcome: 'FAILED',
    occurredAt: dependencies.now?.() ?? new Date(),
    tenantId: input.scope.tenantId,
    applicationId: input.scope.applicationId,
    principalId: input.principalId,
    traceId: input.traceId,
    requestId: input.requestId,
    action: profile.action,
    source: 'policy-integrity-monitor',
    evidenceDigest: operationalEventDigest(attributes),
    attributes,
  };
}

export async function recordPolicyIntegrityFailure(
  input: PolicyIntegrityFailureInput,
): Promise<void> {
  const metricType = input.failure === 'TEMPLATE_RECHECK_FAILED'
    ? undefined
    : input.failure as SafetyAlertType;
  if (metricType) observeSafetyAlert(metricType);
  await appendOperationalSecurityEvent(policyIntegritySecurityEvent(input));
}
