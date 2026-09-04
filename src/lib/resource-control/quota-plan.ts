export type QuotaScopeType =
  | 'TENANT'
  | 'APPLICATION'
  | 'SESSION'
  | 'USER'
  | 'USER_GROUP'
  | 'CREDENTIAL'
  | 'MODEL'
  | 'API';

export type QuotaMetric =
  | 'REQUESTS'
  | 'INPUT_TOKENS'
  | 'OUTPUT_TOKENS'
  | 'CONCURRENCY'
  | 'COST_UNITS';

export type QuotaWindow = 'MINUTE' | 'DAY' | 'MONTH' | 'INSTANT';

export interface QuotaIdentity {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly sessionId?: string;
  readonly userId?: string;
  readonly userGroupIds?: readonly string[];
  readonly credentialId?: string;
  readonly modelId: string;
  readonly apiId: string;
}

export interface QuotaUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUnits: number;
  readonly concurrencyUnits?: number;
}

export interface QuotaClaim {
  readonly scopeType: QuotaScopeType;
  readonly scopeId: string;
  readonly metric: QuotaMetric;
  readonly window: QuotaWindow;
  readonly amount: number;
}

function boundedAmount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`QUOTA_${field}_INVALID`);
  return value;
}

function scopeEntries(identity: QuotaIdentity): readonly [QuotaScopeType, string][] {
  const required: [QuotaScopeType, string][] = [
    ['TENANT', identity.tenantId],
    ['APPLICATION', identity.applicationId],
    ['MODEL', identity.modelId],
    ['API', identity.apiId],
  ];
  if (identity.sessionId) required.push(['SESSION', identity.sessionId]);
  if (identity.userId) required.push(['USER', identity.userId]);
  if (identity.credentialId) required.push(['CREDENTIAL', identity.credentialId]);
  for (const groupId of [...new Set(identity.userGroupIds ?? [])].sort()) {
    required.push(['USER_GROUP', groupId]);
  }
  for (const [type, id] of required) {
    if (!id || id.length > 256 || /[\r\n]/u.test(id)) throw new Error(`QUOTA_${type}_IDENTITY_INVALID`);
  }
  return required;
}

export function buildQuotaClaims(
  identity: QuotaIdentity,
  usage: QuotaUsage,
): readonly QuotaClaim[] {
  const inputTokens = boundedAmount(usage.inputTokens, 'INPUT_TOKENS');
  const outputTokens = boundedAmount(usage.outputTokens, 'OUTPUT_TOKENS');
  const costUnits = boundedAmount(usage.costUnits, 'COST_UNITS');
  const concurrencyUnits = boundedAmount(usage.concurrencyUnits ?? 1, 'CONCURRENCY');
  if (concurrencyUnits === 0) throw new Error('QUOTA_CONCURRENCY_INVALID');
  const claims: QuotaClaim[] = [];
  for (const [scopeType, scopeId] of scopeEntries(identity)) {
    claims.push(
      { scopeType, scopeId, metric: 'CONCURRENCY', window: 'INSTANT', amount: concurrencyUnits },
      { scopeType, scopeId, metric: 'REQUESTS', window: 'MINUTE', amount: 1 },
      { scopeType, scopeId, metric: 'INPUT_TOKENS', window: 'MINUTE', amount: inputTokens },
      { scopeType, scopeId, metric: 'OUTPUT_TOKENS', window: 'MINUTE', amount: outputTokens },
      { scopeType, scopeId, metric: 'COST_UNITS', window: 'DAY', amount: costUnits },
      { scopeType, scopeId, metric: 'COST_UNITS', window: 'MONTH', amount: costUnits },
    );
  }
  return claims;
}
