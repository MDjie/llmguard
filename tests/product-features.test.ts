import { describe, expect, it } from 'vitest';
import { experimentalLabsEnabled } from '@/lib/product-features';

describe('experimental product feature gates', () => {
  it('keeps legacy labs disabled by default', () => {
    expect(experimentalLabsEnabled({})).toBe(false);
  });

  it('requires an explicit true value', () => {
    expect(experimentalLabsEnabled({
      NODE_ENV: 'development',
      GUARDLLM_ENABLE_EXPERIMENTAL_LABS: 'true',
    })).toBe(true);
    expect(experimentalLabsEnabled({
      NODE_ENV: 'development',
      GUARDLLM_ENABLE_EXPERIMENTAL_LABS: 'TRUE',
    })).toBe(true);
    expect(experimentalLabsEnabled({
      NODE_ENV: 'development',
      GUARDLLM_ENABLE_EXPERIMENTAL_LABS: '1',
    })).toBe(false);
  });

  it('cannot be enabled in production', () => {
    expect(experimentalLabsEnabled({
      NODE_ENV: 'production',
      GUARDLLM_ENABLE_EXPERIMENTAL_LABS: 'true',
    })).toBe(false);
  });
});
