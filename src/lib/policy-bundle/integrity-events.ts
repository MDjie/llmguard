import { randomUUID } from 'node:crypto';
import {
  appendOperationalSecurityEvent,
  operationalEventDigest,
  type OperationalEventDomain,
  type OperationalSecurityEvent,
} from '@/lib/operations';
import type { TenantScope } from '@/lib/tenancy';

export type PolicyIntegrityFailure =
  | 'AUDIT_CHAIN_BREAK'
  | 'POLICY_DIGEST_MISMATCH'
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
  POLICY_DIGEST_MISMATCH: {
    domain: 'RUNTIME',
    eventType: 'POLICY.BUNDLE.INTEGRITY_FAILURE',
    severity: 'CRITICAL',
    action: 'FAIL_CLOSED',
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
  await appendOperationalSecurityEvent(policyIntegritySecurityEvent(input));
}
