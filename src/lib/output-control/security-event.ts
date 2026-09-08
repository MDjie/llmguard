import { randomUUID } from 'node:crypto';
import {
  appendOperationalSecurityEvent,
  operationalEventDigest,
  type OperationalSecurityEvent,
} from '@/lib/operations';

export interface OutputControlFailureInput {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly traceId: string;
  readonly requestId: string;
  readonly policyBundleId: string;
  readonly action: string;
  readonly reasonCode: string;
  readonly riskType?: string;
  readonly templateId?: string;
  readonly templateVersion?: number;
  readonly recheckDecisionId?: string;
  readonly recheckReasons?:readonly string[];
  readonly contentHmac?: string;
}

export type OutputControlSecurityEventSink = (
  input: OutputControlFailureInput,
) => void | Promise<void>;

export function outputControlFailureEvent(
  input: OutputControlFailureInput,
  occurredAt = new Date(),
): OperationalSecurityEvent {
  const attributes = {
    reasonCode: input.reasonCode,
    riskType: input.riskType ?? null,
    templateId: input.templateId ?? null,
    templateVersion: input.templateVersion ?? null,
    recheckDecisionId: input.recheckDecisionId ?? null,
    recheckReasons:JSON.stringify(input.recheckReasons?.slice(0,32).map(reason=>reason.slice(0,128))??[]),
  };
  return {
    id: randomUUID(),
    domain: 'MODEL_SECURITY',
    eventType: 'OUTPUT.INTERVENTION.FAILURE',
    severity: input.reasonCode.includes('RECHECK') ? 'CRITICAL' : 'HIGH',
    outcome: 'BLOCKED',
    occurredAt,
    tenantId: input.tenantId,
    applicationId: input.applicationId,
    traceId: input.traceId,
    requestId: input.requestId,
    action: input.action,
    source: 'output-control',
    model: { policyBundleId: input.policyBundleId },
    evidenceDigest: operationalEventDigest({
      traceId: input.traceId,
      requestId: input.requestId,
      policyBundleId: input.policyBundleId,
      ...attributes,
    }),
    contentHmac: input.contentHmac,
    attributes,
  };
}

export async function recordOutputControlFailure(
  input: OutputControlFailureInput,
): Promise<void> {
  await appendOperationalSecurityEvent(outputControlFailureEvent(input));
}
