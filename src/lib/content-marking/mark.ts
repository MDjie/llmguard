import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const CONTENT_MARKING_STANDARD = 'GB 45438-2025';
export const CONTENT_MARK_EXEMPTION_RETENTION_DAYS = 180;
export const DEFAULT_VISIBLE_TEXT_MARK = '[AI生成合成内容]';

export interface GeneratedContentMetadata {
  readonly schemaVersion: '1.0';
  readonly standard: typeof CONTENT_MARKING_STANDARD;
  readonly generatedContent: true;
  readonly modality: 'text' | 'image' | 'audio' | 'video' | 'virtual_scene';
  readonly serviceProvider: string;
  readonly contentId: string;
  readonly createdAt: string;
}

export interface SignedContentMark {
  readonly metadata: GeneratedContentMetadata;
  readonly signature: string;
  readonly keyId: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Content mark contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError('Content mark contains an unsupported value');
}

function requireMarkingKey(key: string): string {
  if (Buffer.byteLength(key, 'utf8') < 32) throw new Error('CONTENT_MARKING_KEY must contain at least 32 bytes');
  return key;
}

export function resolveContentMarkingConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { readonly key: string; readonly keyId: string; readonly providerCode: string; readonly visibleLabel: string } {
  const key = requireMarkingKey(environment.CONTENT_MARKING_KEY ?? '');
  const keyId = environment.CONTENT_MARKING_KEY_ID?.trim() || 'content-mark-hmac-v1';
  const providerCode = environment.CONTENT_MARKING_PROVIDER_CODE?.trim() || '';
  const visibleLabel = environment.CONTENT_MARKING_VISIBLE_LABEL?.trim() || DEFAULT_VISIBLE_TEXT_MARK;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new Error('CONTENT_MARKING_KEY_ID is invalid');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(providerCode)) throw new Error('CONTENT_MARKING_PROVIDER_CODE is required and invalid');
  if (Array.from(visibleLabel).length > 64) throw new Error('CONTENT_MARKING_VISIBLE_LABEL is too long');
  return { key, keyId, providerCode, visibleLabel };
}

export function signContentMetadata(
  metadata: GeneratedContentMetadata,
  key: string,
): string {
  return createHmac('sha256', requireMarkingKey(key)).update(canonicalJson(metadata)).digest('base64url');
}

export function createSignedContentMark(input: {
  readonly modality: GeneratedContentMetadata['modality'];
  readonly serviceProvider: string;
  readonly key: string;
  readonly keyId: string;
  readonly contentId?: string;
  readonly createdAt?: Date;
}): SignedContentMark {
  const metadata: GeneratedContentMetadata = {
    schemaVersion: '1.0',
    standard: CONTENT_MARKING_STANDARD,
    generatedContent: true,
    modality: input.modality,
    serviceProvider: input.serviceProvider,
    contentId: input.contentId ?? randomUUID(),
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  };
  return {
    metadata,
    signature: signContentMetadata(metadata, input.key),
    keyId: input.keyId,
  };
}

export function verifyContentMark(mark: SignedContentMark, key: string): boolean {
  const expected = Buffer.from(signContentMetadata(mark.metadata, key), 'base64url');
  const actual = Buffer.from(mark.signature, 'base64url');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function applyVisibleTextMark(
  text: string,
  label = DEFAULT_VISIBLE_TEXT_MARK,
  position: 'start' | 'end' = 'end',
): string {
  const normalized = text.trim();
  if (!normalized) throw new Error('Text content is empty');
  if (normalized.startsWith(label) || normalized.endsWith(label)) return normalized;
  return position === 'start' ? `${label}\n${normalized}` : `${normalized}\n${label}`;
}

export function exemptionExpiresAt(createdAt = new Date()): Date {
  return new Date(createdAt.getTime() + CONTENT_MARK_EXEMPTION_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
}
