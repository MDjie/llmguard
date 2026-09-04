import { describe, expect, it } from 'vitest';
import {
  DLP_DETOKENIZE_PERMISSION,
  DLP_REVERSIBLE_TOKENIZE_PERMISSION,
  createIrreversibleDlpToken,
  createReversibleDlpToken,
  revealReversibleDlpToken,
  transformDlpText,
  type DlpTransformEntity,
} from '../../src/lib/dlp';

const evidenceKey = 'dlp-evidence-hmac-key-at-least-32-bytes';
const tokenKey = 'dlp-token-hmac-key-at-least-32-bytes!!!';
const encryptionKey = 'dlp-reversible-key-at-least-32-bytes!!';

function entity(text: string, value: string, entityType: string, confidence = 0.9): DlpTransformEntity {
  const start = text.indexOf(value);
  if (start < 0) throw new Error(`missing fixture value for ${entityType}`);
  return { entityType, start, end: start + value.length, confidence };
}

describe('DLP transformation service', () => {
  it('applies partial, full, tokenize and redact operations without returning original values', () => {
    const text = '手机 13812345678；保单 PA-2026-0001；病史 高血压；余额 98231.55';
    const result = transformDlpText(text, [
      entity(text, '13812345678', 'pii.mobile'),
      entity(text, 'PA-2026-0001', 'insurance.policy_number'),
      entity(text, '高血压', 'sensitive.health'),
      entity(text, '98231.55', 'financial.account_balance'),
    ], { evidenceHmacKey: evidenceKey, tokenizationHmacKey: tokenKey });

    expect(result.blocked).toBe(false);
    expect(result.transformedText).toContain('138****5678');
    expect(result.transformedText).toContain('tok_v1_');
    expect(result.transformedText).toContain('[已隐藏敏感数据]');
    expect(result.transformedText).toContain('[已删除敏感数据]');
    expect(new Set(result.ranges.map((range) => range.operation))).toEqual(
      new Set(['PARTIAL_MASK', 'TOKENIZE', 'FULL_MASK', 'REDACT']),
    );
    expect(result.ranges.every((range) => /^[a-f0-9]{64}$/u.test(range.contentHmac))).toBe(true);
    for (const secret of ['13812345678', 'PA-2026-0001', '高血压', '98231.55']) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it('resolves overlapping spans by stricter operation and blocks credentials', () => {
    const text = 'secret-token-value';
    const result = transformDlpText(text, [
      { entityType: 'pii.name', start: 0, end: 6, confidence: 0.99 },
      { entityType: 'credential.secret', start: 0, end: text.length, confidence: 0.8 },
    ], { evidenceHmacKey: evidenceKey, tokenizationHmacKey: tokenKey });
    expect(result.blocked).toBe(true);
    expect(result.transformedText).toBe('');
    expect(result.ranges).toHaveLength(1);
    expect(result.ranges[0]).toMatchObject({ operation: 'BLOCK', entityType: 'credential.secret' });
    expect(JSON.stringify(result)).not.toContain(text);
  });

  it('fails safely to full masking when the irreversible token key is unavailable', () => {
    const text = 'POLICY-001122';
    const result = transformDlpText(text, [entity(text, text, 'insurance.policy_number')], {
      evidenceHmacKey: evidenceKey,
    });
    expect(result.transformedText).toBe('[已隐藏敏感数据]');
    expect(result.ranges[0]?.operation).toBe('FULL_MASK');
    expect(result.degradationReasons).toEqual(['DLP_TOKENIZATION_KEY_UNAVAILABLE']);
  });

  it('keeps irreversible tokens stable and separates reversible token permissions', () => {
    const first = createIrreversibleDlpToken('POLICY-001122', tokenKey, 'policy');
    expect(createIrreversibleDlpToken('POLICY-001122', tokenKey, 'policy')).toBe(first);
    expect(createIrreversibleDlpToken('POLICY-001122', tokenKey, 'claim')).not.toBe(first);
    expect(first).not.toContain('POLICY-001122');

    expect(() => createReversibleDlpToken('customer-secret', {
      encryptionKey,
      keyId: 'dlp-reversible-v1',
      permissions: [],
    })).toThrow('DLP_TOKEN_PERMISSION_DENIED');
    const token = createReversibleDlpToken('customer-secret', {
      encryptionKey,
      keyId: 'dlp-reversible-v1',
      permissions: [DLP_REVERSIBLE_TOKENIZE_PERMISSION],
    });
    expect(token).not.toContain('customer-secret');
    expect(() => revealReversibleDlpToken(token, {
      encryptionKey,
      keyId: 'dlp-reversible-v1',
      permissions: [],
    })).toThrow('DLP_TOKEN_PERMISSION_DENIED');
    expect(revealReversibleDlpToken(token, {
      encryptionKey,
      keyId: 'dlp-reversible-v1',
      permissions: [DLP_DETOKENIZE_PERMISSION],
    })).toBe('customer-secret');
  });

  it('rejects invalid ranges and authenticated-token tampering with stable errors', () => {
    expect(() => transformDlpText('short', [{
      entityType: 'pii.name', start: 0, end: 99, confidence: 1,
    }], { evidenceHmacKey: evidenceKey })).toThrow('DLP_TRANSFORM_RANGE_INVALID');
    const token = createReversibleDlpToken('customer-secret', {
      encryptionKey,
      keyId: 'dlp-reversible-v1',
      permissions: [DLP_REVERSIBLE_TOKENIZE_PERMISSION],
    });
    const payloadOffset = token.lastIndexOf('.') + 5;
    const replacement = token[payloadOffset] === 'A' ? 'B' : 'A';
    const tampered = token.slice(0, payloadOffset) + replacement + token.slice(payloadOffset + 1);
    expect(() => revealReversibleDlpToken(tampered, {
      encryptionKey,
      keyId: 'dlp-reversible-v1',
      permissions: [DLP_DETOKENIZE_PERMISSION],
    })).toThrow('DLP_TOKEN_AUTHENTICATION_FAILED');
  });
});
