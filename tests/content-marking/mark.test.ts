import { describe, expect, it } from 'vitest';
import {
  CONTENT_MARK_EXEMPTION_RETENTION_DAYS,
  applyVisibleTextMark,
  createSignedContentMark,
  exemptionExpiresAt,
  resolveContentMarkingConfiguration,
  verifyContentMark,
} from '../../src/lib/content-marking';

const key = 'content-marking-test-key-longer-than-thirty-two-bytes';

describe('OUT-008 and DAT-007 generated-content marking', () => {
  it('adds a visible text mark once and preserves content', () => {
    const marked = applyVisibleTextMark('保险条款说明');
    expect(marked).toBe('保险条款说明\n[AI生成合成内容]');
    expect(applyVisibleTextMark(marked)).toBe(marked);
  });

  it('signs required generation attributes and detects metadata tampering', () => {
    const mark = createSignedContentMark({
      modality: 'text',
      serviceProvider: 'guardllm-insurance',
      key,
      keyId: 'mark-v1',
      contentId: '88c6a26f-b716-4832-af12-5a05724f3a54',
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
    });
    expect(verifyContentMark(mark, key)).toBe(true);
    expect(verifyContentMark({ ...mark, metadata: { ...mark.metadata, serviceProvider: 'forged' } }, key)).toBe(false);
  });

  it('retains explicit-mark exemptions for at least six months', () => {
    const createdAt = new Date('2026-09-02T00:00:00.000Z');
    expect(exemptionExpiresAt(createdAt).getTime() - createdAt.getTime())
      .toBe(CONTENT_MARK_EXEMPTION_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
  });

  it('fails closed without a strong key and registered provider code', () => {
    expect(() => resolveContentMarkingConfiguration({ CONTENT_MARKING_KEY: 'short' })).toThrow(/32 bytes/);
    expect(() => resolveContentMarkingConfiguration({ CONTENT_MARKING_KEY: key })).toThrow(/PROVIDER_CODE/);
  });
});
