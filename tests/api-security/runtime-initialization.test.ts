import { describe, expect, it } from 'vitest';
import { isRuntimeDatabaseInitializationAllowed } from '../../src/lib/platform/runtime-initialization';

describe('runtime database initialization policy', () => {
  it('is denied in production even when the opt-in flag is set', () => {
    expect(
      isRuntimeDatabaseInitializationAllowed({
        NODE_ENV: 'production',
        ALLOW_RUNTIME_DATABASE_INIT: 'true',
      }),
    ).toBe(false);
  });

  it('is denied by default outside production', () => {
    expect(isRuntimeDatabaseInitializationAllowed({ NODE_ENV: 'development' })).toBe(false);
  });

  it('requires an explicit non-production opt-in', () => {
    expect(
      isRuntimeDatabaseInitializationAllowed({
        NODE_ENV: 'development',
        ALLOW_RUNTIME_DATABASE_INIT: 'true',
      }),
    ).toBe(true);
  });
});
