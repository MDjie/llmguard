import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(path, 'utf8');

describe('offline SDK and gateway toolchain fallback', () => {
  it('uses fixed locally cached images without network or implicit pulls', () => {
    const source = read('scripts/run-toolchain-tests.mjs');
    expect(source).toContain("image: 'golang:1.24-alpine'");
    expect(source).toContain("image: 'maven:3.9.12-eclipse-temurin-21'");
    expect(source).toContain("'--pull=never'");
    expect(source).toContain("'--network', 'none'");
    expect(source).toContain("shell: false");
  });

  it('keeps Maven dependency resolution offline and cache-backed', () => {
    const source = read('scripts/run-toolchain-tests.mjs');
    expect(source).toContain("['mvn', '-o', '-B', 'test']");
    expect(source).toContain(':/root/.m2/repository:ro');
    expect(source).toContain('A populated local Maven repository is required');
  });
});
