import { describe, expect, it } from 'vitest';
import { legacyDimensionCode } from '../../src/lib/detection/v2-compat';

describe('GuardEngine V2 legacy dimension compatibility', () => {
  it('maps canonical secret observations to established API dimension codes', () => {
    expect(legacyDimensionCode('credential.secret')).toBe('credential_secret_leak');
    expect(legacyDimensionCode('business.secret')).toBe('business_sensitive');
  });

  it('preserves already compatible and unknown dimension codes', () => {
    expect(legacyDimensionCode('fraud_scam')).toBe('fraud_scam');
    expect(legacyDimensionCode('future.risk')).toBe('future.risk');
  });
});
