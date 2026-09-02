import { describe, expect, it } from 'vitest';
import { mapCompatibilityRow } from '@/lib/db';

describe('R1-002 legacy database boundary', () => {
  it('maps Drizzle camelCase fields to the declared Supabase-compatible snake_case shape', () => {
    expect(mapCompatibilityRow({
      id: 'policy-1',
      isDefault: true,
      warnThreshold: 80,
    })).toEqual({
      id: 'policy-1',
      is_default: true,
      warn_threshold: 80,
    });
  });

  it('enforces field projection instead of returning the complete row', () => {
    expect(mapCompatibilityRow({
      id: 'policy-1',
      name: 'default',
      sensitiveValue: 'must-not-leak',
    }, ['id', 'name'])).toEqual({
      id: 'policy-1',
      name: 'default',
    });
  });
});
