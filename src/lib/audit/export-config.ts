import type { ApiAuditRecord } from '@/lib/api-security/types';

export type AuditExportDestinationType = 'syslog' | 'kafka';

interface AuditExportFilter {
  readonly eventPrefixes: readonly string[];
  readonly outcomes: readonly ApiAuditRecord['outcome'][];
}

export interface SyslogAuditExportTarget extends AuditExportFilter {
  readonly type: 'syslog';
  readonly destination: string;
  readonly host: string;
  readonly port: number;
  readonly protocol: 'tcp' | 'tls';
  readonly tlsCaPath?: string;
  readonly tlsCertPath?: string;
  readonly tlsKeyPath?: string;
}

export interface KafkaAuditExportTarget extends AuditExportFilter {
  readonly type: 'kafka';
  readonly destination: string;
  readonly brokers: readonly string[];
  readonly topic: string;
  readonly clientId: string;
  readonly ssl: boolean;
  readonly tlsCaPath?: string;
  readonly tlsCertPath?: string;
  readonly tlsKeyPath?: string;
  readonly saslMechanism?: 'plain' | 'scram-sha-256' | 'scram-sha-512';
  readonly saslUsername?: string;
  readonly saslPassword?: string;
}

export type AuditExportTarget = SyslogAuditExportTarget | KafkaAuditExportTarget;

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function port(value: string | undefined, fallback: number): number {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('Audit export port must be between 1 and 65535');
  }
  return parsed;
}

function safeHost(value: string, field: string): string {
  if (!/^[A-Za-z0-9._:-]{1,253}$/.test(value) || value.includes('..')) {
    throw new Error(`${field} contains an invalid host`);
  }
  return value;
}

function filter(environment: Readonly<Record<string, string | undefined>>): AuditExportFilter {
  const outcomes = list(environment.AUDIT_EXPORT_OUTCOMES);
  const validOutcomes = new Set<ApiAuditRecord['outcome']>(['ALLOWED', 'DENIED', 'ERROR']);
  if (outcomes.some((outcome) => !validOutcomes.has(outcome as ApiAuditRecord['outcome']))) {
    throw new Error('AUDIT_EXPORT_OUTCOMES contains an unsupported outcome');
  }
  return {
    eventPrefixes: list(environment.AUDIT_EXPORT_EVENT_PREFIXES),
    outcomes: outcomes as ApiAuditRecord['outcome'][],
  };
}

function productionRequiresTls(enabled: boolean, name: string, environment: Readonly<Record<string, string | undefined>>): void {
  if (environment.NODE_ENV === 'production' && !enabled) {
    throw new Error(`${name} must use TLS in production`);
  }
}

export function resolveAuditExportTargets(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly AuditExportTarget[] {
  const targets: AuditExportTarget[] = [];
  const commonFilter = filter(environment);
  const syslogHost = environment.AUDIT_EXPORT_SYSLOG_HOST?.trim();
  if (syslogHost) {
    const protocol = environment.AUDIT_EXPORT_SYSLOG_PROTOCOL === 'tcp' ? 'tcp' : 'tls';
    productionRequiresTls(protocol === 'tls', 'Syslog audit export', environment);
    const syslogPort = port(environment.AUDIT_EXPORT_SYSLOG_PORT, protocol === 'tls' ? 6514 : 601);
    targets.push({
      ...commonFilter,
      type: 'syslog',
      destination: `syslog:${safeHost(syslogHost, 'AUDIT_EXPORT_SYSLOG_HOST')}:${syslogPort}`,
      host: syslogHost,
      port: syslogPort,
      protocol,
      tlsCaPath: environment.AUDIT_EXPORT_SYSLOG_TLS_CA_PATH?.trim() || undefined,
      tlsCertPath: environment.AUDIT_EXPORT_SYSLOG_TLS_CERT_PATH?.trim() || undefined,
      tlsKeyPath: environment.AUDIT_EXPORT_SYSLOG_TLS_KEY_PATH?.trim() || undefined,
    });
  }

  const brokers = list(environment.AUDIT_EXPORT_KAFKA_BROKERS);
  if (brokers.length > 0) {
    brokers.forEach((broker) => {
      const separator = broker.lastIndexOf(':');
      if (separator < 1) throw new Error('Each Kafka broker must use host:port format');
      safeHost(broker.slice(0, separator), 'AUDIT_EXPORT_KAFKA_BROKERS');
      port(broker.slice(separator + 1), 9093);
    });
    const topic = environment.AUDIT_EXPORT_KAFKA_TOPIC?.trim();
    if (!topic || !/^[A-Za-z0-9._-]{1,249}$/.test(topic)) {
      throw new Error('AUDIT_EXPORT_KAFKA_TOPIC is required and invalid');
    }
    const ssl = environment.AUDIT_EXPORT_KAFKA_SSL !== 'false';
    productionRequiresTls(ssl, 'Kafka audit export', environment);
    const saslMechanism = environment.AUDIT_EXPORT_KAFKA_SASL_MECHANISM as KafkaAuditExportTarget['saslMechanism'];
    if (saslMechanism && !['plain', 'scram-sha-256', 'scram-sha-512'].includes(saslMechanism)) {
      throw new Error('AUDIT_EXPORT_KAFKA_SASL_MECHANISM is unsupported');
    }
    const saslUsername = environment.AUDIT_EXPORT_KAFKA_SASL_USERNAME?.trim();
    const saslPassword = environment.AUDIT_EXPORT_KAFKA_SASL_PASSWORD;
    if (saslMechanism && (!saslUsername || !saslPassword)) {
      throw new Error('Kafka SASL username and password are required when SASL is enabled');
    }
    targets.push({
      ...commonFilter,
      type: 'kafka',
      destination: `kafka:${topic}`,
      brokers,
      topic,
      clientId: environment.AUDIT_EXPORT_KAFKA_CLIENT_ID?.trim() || 'guardllm-audit-exporter',
      ssl,
      tlsCaPath: environment.AUDIT_EXPORT_KAFKA_TLS_CA_PATH?.trim() || undefined,
      tlsCertPath: environment.AUDIT_EXPORT_KAFKA_TLS_CERT_PATH?.trim() || undefined,
      tlsKeyPath: environment.AUDIT_EXPORT_KAFKA_TLS_KEY_PATH?.trim() || undefined,
      saslMechanism,
      saslUsername,
      saslPassword,
    });
  }
  return targets;
}

export function targetAcceptsEvent(target: AuditExportTarget, event: ApiAuditRecord): boolean {
  const outcomeAccepted = target.outcomes.length === 0 || target.outcomes.includes(event.outcome);
  const eventAccepted = target.eventPrefixes.length === 0
    || target.eventPrefixes.some((prefix) => event.event.startsWith(prefix));
  return outcomeAccepted && eventAccepted;
}
