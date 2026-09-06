import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { connect as connectTcp } from 'node:net';
import { connect as connectTls, type ConnectionOptions } from 'node:tls';
import { Kafka, type KafkaConfig, type Producer, type SASLOptions } from 'kafkajs';
import { z } from 'zod';
import { safeFetchJson } from '@/lib/egress/safe-fetch';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import type {
  AuditExportTarget,
  KafkaAuditExportTarget,
  SyslogAuditExportTarget,
  ToneAuditExportTarget,
} from './export-config';

export interface AuditExportPayload {
  readonly schemaVersion: '1.0';
  readonly eventId: string;
  readonly event: string;
  readonly outcome: string;
  readonly status: number;
  readonly requestId: string;
  readonly traceId: string;
  readonly method: string;
  readonly path: string;
  readonly queryString?: string | null;
  readonly clientIp?: string | null;
  readonly userAgent?: string | null;
  readonly latencyMs: number;
  readonly principalId: string | null;
  readonly tenantId: string | null;
  readonly applicationId: string | null;
  readonly occurredAt: string;
  readonly chain: Readonly<{
    partitionKey: string;
    sequence: number;
    previousHash: string;
    eventHash: string;
    keyId: string;
    version: number;
  }>;
}

function tlsFiles(target: { readonly tlsCaPath?: string; readonly tlsCertPath?: string; readonly tlsKeyPath?: string }) {
  return {
    ...(target.tlsCaPath ? { ca: readFileSync(target.tlsCaPath) } : {}),
    ...(target.tlsCertPath ? { cert: readFileSync(target.tlsCertPath) } : {}),
    ...(target.tlsKeyPath ? { key: readFileSync(target.tlsKeyPath) } : {}),
  };
}

function structuredDataValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(']', '\\]');
}

export function formatRfc5424(payload: AuditExportPayload, host = hostname()): string {
  const priority = payload.outcome === 'ERROR' ? 131 : payload.outcome === 'DENIED' ? 132 : 134;
  const data = [
    `eventId="${structuredDataValue(payload.eventId)}"`,
    `traceId="${structuredDataValue(payload.traceId)}"`,
    `outcome="${structuredDataValue(payload.outcome)}"`,
    `chainHash="${structuredDataValue(payload.chain.eventHash)}"`,
  ].join(' ');
  return `<${priority}>1 ${payload.occurredAt} ${host} guardllm - ${payload.event} [guardllm@32473 ${data}] ${JSON.stringify(payload)}`;
}

async function sendSyslog(target: SyslogAuditExportTarget, payload: AuditExportPayload): Promise<void> {
  const message = formatRfc5424(payload);
  const frame = `${Buffer.byteLength(message, 'utf8')} ${message}`;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve();
    };
    const socket = target.protocol === 'tls'
      ? connectTls({
          host: target.host,
          port: target.port,
          servername: target.host,
          rejectUnauthorized: true,
          ...tlsFiles(target),
        } satisfies ConnectionOptions)
      : connectTcp({ host: target.host, port: target.port });
    socket.setTimeout(15_000);
    socket.once('error', (error) => finish(error));
    socket.once('timeout', () => {
      socket.destroy();
      finish(new Error('Syslog delivery timed out'));
    });
    const readyEvent = target.protocol === 'tls' ? 'secureConnect' : 'connect';
    socket.once(readyEvent, () => {
      socket.end(frame, 'utf8', () => finish());
    });
  });
}

let producerCache: { readonly fingerprint: string; readonly producer: Producer } | undefined;

function kafkaSasl(target: KafkaAuditExportTarget): SASLOptions | undefined {
  if (!target.saslMechanism || !target.saslUsername || !target.saslPassword) return undefined;
  return {
    mechanism: target.saslMechanism,
    username: target.saslUsername,
    password: target.saslPassword,
  } as SASLOptions;
}

async function kafkaProducer(target: KafkaAuditExportTarget): Promise<Producer> {
  const fingerprint = JSON.stringify({
    brokers: target.brokers,
    clientId: target.clientId,
    ssl: target.ssl,
    saslMechanism: target.saslMechanism,
    saslUsername: target.saslUsername,
  });
  if (producerCache?.fingerprint === fingerprint) return producerCache.producer;
  if (producerCache) await producerCache.producer.disconnect();
  const config: KafkaConfig = {
    clientId: target.clientId,
    brokers: [...target.brokers],
    ssl: target.ssl ? { rejectUnauthorized: true, ...tlsFiles(target) } : false,
    sasl: kafkaSasl(target),
    connectionTimeout: 10_000,
    requestTimeout: 15_000,
    retry: { retries: 0 },
  };
  const producer = new Kafka(config).producer({ allowAutoTopicCreation: false, idempotent: true });
  await producer.connect();
  producerCache = { fingerprint, producer };
  return producer;
}

async function sendKafka(target: KafkaAuditExportTarget, payload: AuditExportPayload): Promise<void> {
  const producer = await kafkaProducer(target);
  await producer.send({
    topic: target.topic,
    acks: -1,
    messages: [{
      key: payload.eventId,
      value: JSON.stringify(payload),
      headers: {
        'guard-schema-version': payload.schemaVersion,
        'guard-event': payload.event,
        'guard-outcome': payload.outcome,
        'guard-trace-id': payload.traceId,
      },
    }],
  });
}

const toneReceiptSchema = z.object({
  accepted: z.literal(true),
  eventId: z.string().min(1).max(128),
  statusId: z.string().min(1).max(256).optional(),
}).strict();

export function buildToneEnvelope(
  target: ToneAuditExportTarget,
  payload: AuditExportPayload,
) {
  const event = {
    schemaVersion: '1.0' as const,
    source: 'guardllm',
    eventId: payload.eventId,
    eventType: payload.event,
    outcome: payload.outcome,
    severity: payload.outcome === 'ERROR'
      ? 'HIGH' as const
      : payload.outcome === 'DENIED'
        ? 'MEDIUM' as const
        : 'INFO' as const,
    occurredAt: payload.occurredAt,
    traceId: payload.traceId,
    requestId: payload.requestId,
    tenantId: payload.tenantId,
    applicationId: payload.applicationId,
    principalId: payload.principalId,
    http: {
      method: payload.method,
      path: payload.path,
      status: payload.status,
      latencyMs: payload.latencyMs,
    },
    integrity: payload.chain,
  };
  const signature = createHmac('sha256', target.hmacKey)
    .update(canonicalJson(event))
    .digest('base64url');
  return {
    event,
    headers: {
      'idempotency-key': payload.eventId,
      'x-guard-signature-algorithm': 'HMAC-SHA256',
      'x-guard-signature-key-id': target.keyId,
      'x-guard-signature': signature,
    },
  };
}

async function sendTone(target: ToneAuditExportTarget, payload: AuditExportPayload): Promise<void> {
  const envelope = buildToneEnvelope(target, payload);
  const receipt = toneReceiptSchema.parse(await safeFetchJson({
    baseUrl: target.baseUrl,
    path: target.path,
    providerType: 'custom',
    headers: envelope.headers,
    body: envelope.event,
    timeoutMs: 15_000,
    maxRequestBytes: 1_048_576,
    maxResponseBytes: 64 * 1_024,
  }));
  if (receipt.eventId !== payload.eventId) {
    throw new Error('TONE_RECEIPT_EVENT_MISMATCH');
  }
}

export async function sendAuditExport(target: AuditExportTarget, payload: AuditExportPayload): Promise<void> {
  if (target.type === 'syslog') return sendSyslog(target, payload);
  if (target.type === 'kafka') return sendKafka(target, payload);
  return sendTone(target, payload);
}
