import { describe, expect, it } from 'vitest';
import { getPIIStats, hasPII, maskPII, maskRange } from '../../src/lib/guardrail/pii-masker';

describe('PII masking', () => {
  it('masks every supported sensitive value without retaining secrets', () => {
    const source = [
      'phone=13812345678',
      'id=110101199001011234',
      'card=4532015112830366',
      'email=alice@example.com',
      'ip=192.168.1.20',
      'token=sk-abcdefghijklmnop',
    ].join(' ');

    const result = maskPII(source);
    const types = new Set(result.maskedItems.map((item) => item.type));

    expect(result.hasMasked).toBe(true);
    expect(types).toEqual(new Set(['phone', 'idcard', 'bankcard', 'email', 'ip', 'apikey']));
    expect(result.maskedItems.every((item) => !Object.hasOwn(item, 'original'))).toBe(true);
    for (const secret of [
      '13812345678',
      '110101199001011234',
      '4532015112830366',
      'alice@example.com',
      '192.168.1.20',
      'abcdefghijklmnop',
    ]) {
      expect(result.maskedText).not.toContain(secret);
    }
    expect(result.maskedText).toContain('138****5678');
    expect(result.maskedText).toContain('a***@example.com');
    expect(result.maskedText).toContain('192.168.*.*');
    expect(result.maskedText).toContain('token=****');
  });

  it('preserves safe text and reports stable aggregate statistics', () => {
    const safeText = 'No credentials or personal identifiers are present.';

    expect(maskPII(safeText)).toEqual({
      maskedText: safeText,
      maskedItems: [],
      hasMasked: false,
    });
    expect(hasPII(safeText)).toBe(false);
    expect(getPIIStats('13812345678 and 13987654321')).toEqual({ phone: 2 });
  });

  it('masks only valid ranges and leaves invalid ranges unchanged', () => {
    expect(maskRange('abcdef', 1, 4)).toBe('a***ef');
    expect(maskRange('abcdef', 1, 4, '#')).toBe('a###ef');
    expect(maskRange('abcdef', -1, 3)).toBe('abcdef');
    expect(maskRange('abcdef', 4, 4)).toBe('abcdef');
    expect(maskRange('abcdef', 2, 20)).toBe('abcdef');
  });
});
