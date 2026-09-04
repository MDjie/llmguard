import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const productionEntrypoints = [
  'src/app/api/detect/route.ts',
  'src/app/api/policies/compare/route.ts',
  'src/lib/document/detector.ts',
] as const;

const guardedExperimentalEntrypoint = 'src/app/api/simulate/route.ts';

describe('authoritative production decision path', () => {
  it.each(productionEntrypoints)('%s delegates decisions to Guard Engine V2', async (file) => {
    const source = await readFile(resolve(process.cwd(), file), 'utf8');

    expect(source).toMatch(
      /import\s*\{\s*detectWithGuardEngineV2\s*\}\s*from\s*['"]@\/lib\/detection\/v2-compat['"]/u,
    );
    expect(source).toMatch(/\bdetectWithGuardEngineV2\s*\(/u);
    expect(source).not.toContain('detectWithDynamicRules');
  });

  it('keeps the legacy simulation path behind an explicit feature gate', async () => {
    const source = await readFile(resolve(process.cwd(), guardedExperimentalEntrypoint), 'utf8');
    expect(source).toContain('experimentalLabsEnabled');
    expect(source).toContain('detectWithGuardEngineV2');
    expect(source).toContain("code: 'EXPERIMENTAL_FEATURE_DISABLED'");
  });
});
