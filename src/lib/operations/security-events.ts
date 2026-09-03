import { createHash, randomUUID } from 'node:crypto';
import type { ApiAuditRecord } from '@/lib/api-security/types';
import { db } from '@/storage/database/shared/db';
import { operationalSecurityEvents } from '@/storage/database/shared/schema';

export type OperationalEventDomain =
  | 'AUDIT'
  | 'RUNTIME'
  | 'NETWORK_SECURITY'
  | 'MODEL_SECURITY';

export interface NetworkEventContext {
  readonly captureMode: 'APPLICATION_PROXY' | 'L2_TRANSPARENT';
  readonly sourceInterface?: string;
  readonly sourceIp?: string;
  readonly sourceMac?: string;
  readonly sourcePort?: number;
  readonly destinationIp?: string;
  readonly destinationMac?: string;
  readonly destinationPort?: number;
  readonly protocol?: string;
  readonly sessionId?: string;
  readonly certificateFingerprint?: string;
}

export interface ModelEventContext {
  readonly modelId?: string;
  readonly modelVersion?: string;
  readonly policyBundleId?: string;
  readonly detectorId?: string;
  readonly detectorVersion?: string;
  readonly latencyMs?: number;
  readonly queueDepth?: number;
}

export interface OperationalSecurityEvent {
  readonly id: string;
  readonly domain: OperationalEventDomain;
  readonly eventType: string;
  readonly severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly outcome: string;
  readonly occurredAt: Date;
  readonly tenantId?: string;
  readonly applicationId?: string;
  readonly principalId?: string;
  readonly traceId?: string;
  readonly requestId?: string;
  readonly action?: string;
  readonly source: string;
  readonly network?: NetworkEventContext;
  readonly model?: ModelEventContext;
  readonly evidenceDigest: string;
  readonly contentHmac?: string;
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
}

const HASH = /^[a-f0-9]{64}$/;
const SAFE_EVENT_TYPE = /^[A-Z][A-Z0-9_.-]{0,127}$/;

function assertPort(port: number | undefined): void {
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65_535)) {
    throw new Error('OPERATIONAL_EVENT_PORT_INVALID');
  }
}

export function validateOperationalSecurityEvent(event: OperationalSecurityEvent): void {
  if (!SAFE_EVENT_TYPE.test(event.eventType) || !event.source || event.source.length > 128) {
    throw new Error('OPERATIONAL_EVENT_IDENTITY_INVALID');
  }
  if (!HASH.test(event.evidenceDigest) || (event.contentHmac && !HASH.test(event.contentHmac))) {
    throw new Error('OPERATIONAL_EVENT_DIGEST_INVALID');
  }
  if (!Number.isFinite(event.occurredAt.getTime())) {
    throw new Error('OPERATIONAL_EVENT_TIME_INVALID');
  }
  if (event.domain === 'NETWORK_SECURITY' && !event.network) {
    throw new Error('OPERATIONAL_EVENT_NETWORK_CONTEXT_REQUIRED');
  }
  if (event.network) {
    assertPort(event.network.sourcePort);
    assertPort(event.network.destinationPort);
    const hasMac = Boolean(event.network.sourceMac || event.network.destinationMac);
    if (hasMac && event.network.captureMode !== 'L2_TRANSPARENT') {
      throw new Error('OPERATIONAL_EVENT_MAC_NOT_OBSERVED');
    }
  }
  if (event.domain === 'MODEL_SECURITY' && !event.model) {
    throw new Error('OPERATIONAL_EVENT_MODEL_CONTEXT_REQUIRED');
  }
  if (Buffer.byteLength(JSON.stringify(event.attributes), 'utf8') > 32 * 1_024) {
    throw new Error('OPERATIONAL_EVENT_ATTRIBUTES_TOO_LARGE');
  }
}

export function operationalAuditEvent(
  event: ApiAuditRecord,
  input: {
    readonly id?: string;
    readonly occurredAt?: Date;
    readonly evidenceDigest: string;
  },
): OperationalSecurityEvent {
  return {
    id: input.id ?? randomUUID(),
    domain: 'AUDIT',
    eventType: event.event.toUpperCase().replace(/[^A-Z0-9_.-]/g, '_'),
    severity: event.outcome === 'ERROR'
      ? 'HIGH'
      : event.outcome === 'DENIED'
        ? 'MEDIUM'
        : 'INFO',
    outcome: event.outcome,
    occurredAt: input.occurredAt ?? new Date(),
    tenantId: event.tenantId,
    applicationId: event.applicationId,
    principalId: event.principalId,
    traceId: event.traceId,
    requestId: event.requestId,
    action: event.method,
    source: 'api-security',
    evidenceDigest: input.evidenceDigest,
    attributes: {
      httpStatus: event.status,
      path: event.path,
      latencyMs: event.latencyMs,
    },
  };
}

export async function appendOperationalSecurityEvent(
  event: OperationalSecurityEvent,
): Promise<void> {
  validateOperationalSecurityEvent(event);
  await db.insert(operationalSecurityEvents).values(operationalSecurityEventRow(event));
}

export function operationalSecurityEventRow(event: OperationalSecurityEvent) {
  validateOperationalSecurityEvent(event);
  return {
    id: event.id,
    domain: event.domain,
    eventType: event.eventType,
    severity: event.severity,
    outcome: event.outcome,
    occurredAt: event.occurredAt,
    tenantId: event.tenantId,
    applicationId: event.applicationId,
    principalId: event.principalId,
    traceId: event.traceId,
    requestId: event.requestId,
    action: event.action,
    source: event.source,
    network: event.network ? { ...event.network } : undefined,
    model: event.model ? { ...event.model } : undefined,
    evidenceDigest: event.evidenceDigest,
    contentHmac: event.contentHmac,
    attributes: { ...event.attributes },
  };
}

export function operationalEventDigest(
  value: Readonly<Record<string, unknown>>,
): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
