import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const productionEntrypoints = [
  'src/app/api/detect/route.ts',
  'src/app/api/simulate/route.ts',
  'src/app/api/policies/compare/route.ts',
  'src/lib/document/detector.ts',
] as const;

describe('authoritative production decision path', () => {
  it.each(productionEntrypoints)('%s delegates decisions to Guard Engine V2', async (file) => {
    const source = await readFile(resolve(process.cwd(), file), 'utf8');
    expect(source).toContain('detectWithGuardEngineV2');
    expect(source).not.toContain('detectWithDynamicRules');
  });
});
