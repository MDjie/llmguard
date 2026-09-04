import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';

export type DlpTransformOperation =
  | 'PARTIAL_MASK'
  | 'FULL_MASK'
  | 'TOKENIZE'
  | 'REDACT'
  | 'BLOCK';

export interface DlpTransformEntity {
  readonly entityType: string;
  readonly start: number;
  readonly end: number;
  readonly confidence: number;
  readonly contentHmac?: string;
}

export interface DlpTransformRange {
  readonly entityType: string;
  readonly operation: DlpTransformOperation;
  readonly start: number;
  readonly end: number;
  readonly outputStart: number;
  readonly outputEnd: number;
  readonly maskedPreview: string;
  readonly contentHmac: string;
}

export interface DlpTransformationResult {
  readonly transformedText: string;
  readonly ranges: readonly DlpTransformRange[];
  readonly blocked: boolean;
  readonly outputHash: string;
  readonly degradationReasons: readonly string[];
}

export interface DlpTransformationOptions {
  readonly evidenceHmacKey: string | Buffer;
  readonly tokenizationHmacKey?: string | Buffer;
  readonly operationByEntityType?: Readonly<Record<string, DlpTransformOperation>>;
}

export interface ReversibleDlpTokenOptions {
  readonly encryptionKey: string | Buffer;
  readonly keyId: string;
  readonly permissions: readonly string[];
}

export const DLP_REVERSIBLE_TOKENIZE_PERMISSION = 'dlp:tokenize:reversible';
export const DLP_DETOKENIZE_PERMISSION = 'dlp:detokenize';

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const OPERATION_PRIORITY: Readonly<Record<DlpTransformOperation, number>> = {
  BLOCK: 5,
  FULL_MASK: 4,
  REDACT: 3,
  TOKENIZE: 2,
  PARTIAL_MASK: 1,
};

const DEFAULT_OPERATIONS: Readonly<Record<string, DlpTransformOperation>> = {
  'credential.secret': 'BLOCK',
  'internal.system_prompt': 'BLOCK',
  'pii.name': 'PARTIAL_MASK',
  'person.name': 'PARTIAL_MASK',
  'pii.mobile': 'PARTIAL_MASK',
  'pii.email': 'PARTIAL_MASK',
  'pii.identity.prc': 'PARTIAL_MASK',
  'pii.passport': 'PARTIAL_MASK',
  'pii.address': 'FULL_MASK',
  'customer.number': 'TOKENIZE',
  'insurance.policy_number': 'TOKENIZE',
  'insurance.claim_number': 'TOKENIZE',
  'insurance.beneficiary': 'FULL_MASK',
  'sensitive.health': 'FULL_MASK',
  'sensitive.medical': 'FULL_MASK',
  'insurance.underwriting': 'FULL_MASK',
  'financial.bank_card': 'PARTIAL_MASK',
  'financial.account_balance': 'REDACT',
  'financial.income': 'REDACT',
  'financial.credit': 'REDACT',
  'financial.payment': 'REDACT',
  'internal.pricing': 'REDACT',
  'internal.unreleased_product': 'REDACT',
  'internal.rule': 'REDACT',
  'internal.architecture': 'REDACT',
  'internal.staff': 'REDACT',
};

function requireKey(key: string | Buffer, code: string): Buffer {
  if (Buffer.byteLength(key) < 32) throw new Error(code);
  return createHash('sha256').update('guardllm:dlp:key:v1:').update(key).digest();
}

function operationFor(
  entityType: string,
  overrides: Readonly<Record<string, DlpTransformOperation>> | undefined,
): DlpTransformOperation {
  return overrides?.[entityType] ?? DEFAULT_OPERATIONS[entityType] ?? 'FULL_MASK';
}

function overlaps(left: DlpTransformEntity, right: DlpTransformEntity): boolean {
  return left.start < right.end && right.start < left.end;
}

function assertEntity(text: string, entity: DlpTransformEntity): void {
  if (!entity.entityType.trim()) throw new Error('DLP_TRANSFORM_ENTITY_TYPE_REQUIRED');
  if (
    !Number.isSafeInteger(entity.start) ||
    !Number.isSafeInteger(entity.end) ||
    entity.start < 0 ||
    entity.end <= entity.start ||
    entity.end > text.length
  ) throw new Error('DLP_TRANSFORM_RANGE_INVALID');
  if (!Number.isFinite(entity.confidence) || entity.confidence < 0 || entity.confidence > 1) {
    throw new Error('DLP_TRANSFORM_CONFIDENCE_INVALID');
  }
}

function resolveOverlaps(
  text: string,
  entities: readonly DlpTransformEntity[],
  overrides: Readonly<Record<string, DlpTransformOperation>> | undefined,
): readonly (DlpTransformEntity & { readonly operation: DlpTransformOperation })[] {
  entities.forEach((entity) => assertEntity(text, entity));
  const ranked = entities.map((entity) => ({
    ...entity,
    operation: operationFor(entity.entityType, overrides),
  })).sort((left, right) =>
    OPERATION_PRIORITY[right.operation] - OPERATION_PRIORITY[left.operation] ||
    right.confidence - left.confidence ||
    (right.end - right.start) - (left.end - left.start) ||
    left.start - right.start ||
    left.entityType.localeCompare(right.entityType));
  const selected: typeof ranked = [];
  for (const entity of ranked) {
    if (!selected.some((existing) => overlaps(existing, entity))) selected.push(entity);
  }
  return selected.sort((left, right) => left.start - right.start || left.end - right.end);
}

function partialMask(value: string, entityType: string): string {
  if (entityType === 'pii.email') {
    const at = value.indexOf('@');
    if (at > 0) return `${value[0]}***${value.slice(at)}`;
  }
  const compactDigits = value.replace(/[ -]/gu, '');
  if (entityType === 'pii.mobile' && compactDigits.length === 11) {
    return `${compactDigits.slice(0, 3)}****${compactDigits.slice(-4)}`;
  }
  if (entityType === 'pii.identity.prc' && compactDigits.length === 18) {
    return `${compactDigits.slice(0, 6)}********${compactDigits.slice(-4)}`;
  }
  if (entityType === 'financial.bank_card' && compactDigits.length >= 16) {
    return `${compactDigits.slice(0, 4)}********${compactDigits.slice(-4)}`;
  }
  if (entityType === 'pii.name') {
    return value.length <= 1 ? '*' : `${value[0]}${'*'.repeat(Math.min(6, value.length - 1))}`;
  }
  if (entityType === 'pii.address') {
    const visible = Math.min(3, Math.max(1, Math.floor(value.length / 5)));
    return `${value.slice(0, visible)}${'*'.repeat(Math.min(12, value.length - visible))}`;
  }
  if (value.length <= 2) return '*'.repeat(value.length);
  const prefix = Math.min(3, Math.floor(value.length / 3));
  const suffix = Math.min(4, Math.floor(value.length / 3));
  return `${value.slice(0, prefix)}${'*'.repeat(Math.min(12, value.length - prefix - suffix))}${value.slice(-suffix)}`;
}

export function createIrreversibleDlpToken(
  value: string,
  key: string | Buffer,
  namespace = 'default',
): string {
  const secret = requireKey(key, 'DLP_TOKENIZATION_KEY_INVALID');
  const digest = createHmac('sha256', secret)
    .update('guardllm:dlp:token:v1:')
    .update(namespace)
    .update('\0')
    .update(value, 'utf8')
    .digest('base64url')
    .slice(0, 24);
  return `tok_v1_${digest}`;
}

function requirePermission(permissions: readonly string[], permission: string): void {
  if (!permissions.includes(permission)) throw new Error('DLP_TOKEN_PERMISSION_DENIED');
}

export function createReversibleDlpToken(
  value: string,
  options: ReversibleDlpTokenOptions,
): string {
  requirePermission(options.permissions, DLP_REVERSIBLE_TOKENIZE_PERMISSION);
  if (!KEY_ID.test(options.keyId)) throw new Error('DLP_TOKEN_KEY_ID_INVALID');
  const key = requireKey(options.encryptionKey, 'DLP_REVERSIBLE_KEY_INVALID');
  const iv = randomBytes(12);
  const aad = Buffer.from(`guardllm:dlp:reversible:v1:${options.keyId}`, 'utf8');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  return `rtok_v1.${options.keyId}.${payload}`;
}

export function revealReversibleDlpToken(
  token: string,
  options: ReversibleDlpTokenOptions,
): string {
  requirePermission(options.permissions, DLP_DETOKENIZE_PERMISSION);
  const [version, keyId, encoded, extra] = token.split('.');
  if (version !== 'rtok_v1' || keyId !== options.keyId || !encoded || extra !== undefined) {
    throw new Error('DLP_TOKEN_FORMAT_INVALID');
  }
  const payload = Buffer.from(encoded, 'base64url');
  if (payload.length < 29) throw new Error('DLP_TOKEN_FORMAT_INVALID');
  const key = requireKey(options.encryptionKey, 'DLP_REVERSIBLE_KEY_INVALID');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(`guardllm:dlp:reversible:v1:${options.keyId}`, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('DLP_TOKEN_AUTHENTICATION_FAILED');
  }
}

function replacementFor(
  value: string,
  entityType: string,
  operation: DlpTransformOperation,
  tokenizationKey: string | Buffer | undefined,
): { readonly value: string; readonly operation: DlpTransformOperation; readonly degraded: boolean } {
  if (operation === 'PARTIAL_MASK') return { value: partialMask(value, entityType), operation, degraded: false };
  if (operation === 'FULL_MASK') return { value: '[已隐藏敏感数据]', operation, degraded: false };
  if (operation === 'REDACT') return { value: '[已删除敏感数据]', operation, degraded: false };
  if (operation === 'BLOCK') return { value: '', operation, degraded: false };
  if (!tokenizationKey || Buffer.byteLength(tokenizationKey) < 32) {
    return { value: '[已隐藏敏感数据]', operation: 'FULL_MASK', degraded: true };
  }
  return {
    value: createIrreversibleDlpToken(value, tokenizationKey, entityType),
    operation,
    degraded: false,
  };
}

export function transformDlpText(
  text: string,
  entities: readonly DlpTransformEntity[],
  options: DlpTransformationOptions,
): DlpTransformationResult {
  const evidenceKey = requireKey(options.evidenceHmacKey, 'DLP_EVIDENCE_HMAC_KEY_INVALID');
  const resolved = resolveOverlaps(text, entities, options.operationByEntityType);
  if (resolved.some((entity) => entity.operation === 'BLOCK')) {
    return {
      transformedText: '',
      ranges: resolved.map((entity) => ({
        entityType: entity.entityType,
        operation: entity.operation,
        start: entity.start,
        end: entity.end,
        outputStart: 0,
        outputEnd: 0,
        maskedPreview: '',
        contentHmac: entity.contentHmac ?? createHmac('sha256', evidenceKey)
          .update(text.slice(entity.start, entity.end), 'utf8').digest('hex'),
      })),
      blocked: true,
      outputHash: createHash('sha256').update('').digest('hex'),
      degradationReasons: [],
    };
  }

  let transformedText = text;
  const applied: Array<{
    readonly entity: typeof resolved[number];
    readonly replacement: string;
    readonly operation: DlpTransformOperation;
    readonly degraded: boolean;
  }> = [];
  for (const entity of [...resolved].reverse()) {
    const originalValue = text.slice(entity.start, entity.end);
    const replacement = replacementFor(
      originalValue,
      entity.entityType,
      entity.operation,
      options.tokenizationHmacKey,
    );
    transformedText = transformedText.slice(0, entity.start) + replacement.value +
      transformedText.slice(entity.end);
    applied.unshift({ entity, replacement: replacement.value, operation: replacement.operation, degraded: replacement.degraded });
  }

  let outputDelta = 0;
  const ranges = applied.map(({ entity, replacement, operation }): DlpTransformRange => {
    const outputStart = entity.start + outputDelta;
    const outputEnd = outputStart + replacement.length;
    outputDelta += replacement.length - (entity.end - entity.start);
    return {
      entityType: entity.entityType,
      operation,
      start: entity.start,
      end: entity.end,
      outputStart,
      outputEnd,
      maskedPreview: replacement.slice(0, 96),
      contentHmac: entity.contentHmac ?? createHmac('sha256', evidenceKey)
        .update(text.slice(entity.start, entity.end), 'utf8').digest('hex'),
    };
  });
  return {
    transformedText,
    ranges,
    blocked: false,
    outputHash: createHash('sha256').update(transformedText, 'utf8').digest('hex'),
    degradationReasons: applied.some((item) => item.degraded)
      ? ['DLP_TOKENIZATION_KEY_UNAVAILABLE']
      : [],
  };
}
