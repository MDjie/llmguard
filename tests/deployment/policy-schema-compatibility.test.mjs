import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(path, 'utf8');

describe('policy schema compatibility', () => {
  it('defines created_at for fresh and upgraded policy dimension configuration tables', () => {
    const initialSchema = read('scripts/init-database-new.sql');
    const migration = read('drizzle/0036_policy_dimension_config_created_at.sql');
    const compose = read('docker-compose.yml');

    expect(initialSchema).toMatch(
      /CREATE TABLE policy_dimension_config[\s\S]*created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/,
    );
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS created_at timestamptz');
    expect(migration).toContain('WHERE created_at IS NULL');
    expect(migration).toContain('ALTER COLUMN created_at SET NOT NULL');
    expect(compose).toContain('./drizzle/0036_policy_dimension_config_created_at.sql');
  });
});
