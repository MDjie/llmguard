import { mkdtempSync, writeFileSync, renameSync, rmSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatewaySetting } from '@/lib/gateway-runtime/settings';

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function file(value: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'guard-setting-'));
  directories.push(directory);
  const name = path.join(directory, 'secret'); writeFileSync(name, value);
  vi.stubEnv('TEST_GATEWAY_SETTING_FILE', name); vi.stubEnv('TEST_GATEWAY_SETTING', '');
  return name;
}
describe('operator setting files', () => {
  it('rejects ambiguous, missing, directory and oversized settings without disclosing content', () => {
    const name = file('confidential-value');
    vi.stubEnv('TEST_GATEWAY_SETTING', 'conflicting-secret');
    expect(() => gatewaySetting('TEST_GATEWAY_SETTING', 'TEST_GATEWAY_SETTING_FILE')).toThrow('GATEWAY_SETTING_AMBIGUOUS');
    vi.stubEnv('TEST_GATEWAY_SETTING', '');
    vi.stubEnv('TEST_GATEWAY_SETTING_FILE', path.dirname(name));
    expect(() => gatewaySetting('TEST_GATEWAY_SETTING', 'TEST_GATEWAY_SETTING_FILE')).toThrow('GATEWAY_SETTING_TOO_LARGE');
    vi.stubEnv('TEST_GATEWAY_SETTING_FILE', name + '.missing');
    expect(() => gatewaySetting('TEST_GATEWAY_SETTING', 'TEST_GATEWAY_SETTING_FILE')).toThrow('GATEWAY_SETTING_UNAVAILABLE');
    vi.stubEnv('TEST_GATEWAY_SETTING_FILE', name); writeFileSync(name, 'x'.repeat(1048577));
    expect(() => gatewaySetting('TEST_GATEWAY_SETTING', 'TEST_GATEWAY_SETTING_FILE')).toThrow('GATEWAY_SETTING_TOO_LARGE');
  });
  it('observes atomic rotation even when replacement preserves size and modification time', () => {
    const name = file('first-secret'); const modified = statSync(name).mtime;
    expect(gatewaySetting('TEST_GATEWAY_SETTING', 'TEST_GATEWAY_SETTING_FILE')).toBe('first-secret');
    writeFileSync(name + '.next', 'other-secret'); utimesSync(name + '.next', modified, modified); renameSync(name + '.next', name);
    expect(gatewaySetting('TEST_GATEWAY_SETTING', 'TEST_GATEWAY_SETTING_FILE')).toBe('other-secret');
  });
});
