import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const cases = [
  ['packages/contracts', 'guard-v1.schema.json', 'generate.mjs', 'manifest.json'],
  ['packages/contracts', 'gateway-v2.schema.json', 'generate-gateway-v2.mjs', 'gateway-v2-manifest.json'],
  ['packages/contracts-appliance', 'appliance-v1.schema.json', 'generate.mjs', 'manifest.json'],
];

describe('cross-platform contract generation', () => {
  it.each(cases)('%s %s generates identical bytes from LF and CRLF sources', (packagePath, sourceName, scriptName, manifestName) => {
    const prefix = path.join(tmpdir(), 'guard-contract-eol-');
    const directory = mkdtempSync(prefix);
    try {
      const source = readFileSync(path.join(packagePath, 'model', sourceName), 'utf8').replace(/\r\n/g, '\n');
      const script = readFileSync(path.join(packagePath, 'scripts', scriptName), 'utf8');
      const manifests = [];
      for (const [name, text] of [['lf', source], ['crlf', source.replace(/\n/g, '\r\n')]]) {
        const packageRoot = path.join(directory, name, packagePath);
        mkdirSync(path.join(packageRoot, 'scripts'), { recursive: true });
        mkdirSync(path.join(packageRoot, 'model'), { recursive: true });
        writeFileSync(path.join(packageRoot, 'scripts', scriptName), script);
        writeFileSync(path.join(packageRoot, 'model', sourceName), text);
        execFileSync(process.execPath, [path.join(packageRoot, 'scripts', scriptName)], { windowsHide: true, stdio: 'pipe' });
        execFileSync(process.execPath, [path.join(packageRoot, 'scripts', scriptName), '--check'], { windowsHide: true, stdio: 'pipe' });
        const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'generated', manifestName), 'utf8'));
        expect(manifest.sourceSha256).toBe(createHash('sha256').update(source).digest('hex'));
        for (const [relative, hash] of Object.entries(manifest.outputs)) {
          const output = readFileSync(path.resolve(packageRoot, relative));
          expect(output.includes(Buffer.from('\r\n'))).toBe(false);
          expect(createHash('sha256').update(output).digest('hex')).toBe(hash);
          expect(output.equals(readFileSync(path.resolve(packagePath, relative)))).toBe(true);
        }
        manifests.push(manifest);
      }
      expect(manifests[0]).toEqual(manifests[1]);
    } finally {
      if (!path.resolve(directory).startsWith(path.resolve(prefix))) throw new Error('UNSAFE_TEMP_DIRECTORY');
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
