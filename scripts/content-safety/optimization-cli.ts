import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
export function options(names: readonly string[]): Record<string, string | boolean | undefined> {
  const config: Record<string, { type: 'string' | 'boolean' }> = { help: { type: 'boolean' } };
  for (const name of names) config[name] = { type: 'string' };
  const values = parseArgs({ options: config, strict: true }).values;
  const result: Record<string, string | boolean | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) throw new Error('MULTIPLE_ARGUMENT_VALUES');
    result[key] = value;
  }
  return result;
}
export function required(value: string | boolean | undefined, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('ARGUMENT_REQUIRED:' + name);
  return value;
}
export async function jsonFile(file: string): Promise<unknown> { return JSON.parse(await readFile(file, 'utf8')) as unknown; }
export function sha256(content: string): string { return createHash('sha256').update(content).digest('hex'); }
export async function writeArtifact(file: string, value: unknown) {
  const root = process.cwd(); const target = path.resolve(file); const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('OUTPUT_OUTSIDE_WORKSPACE');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
}
export function fail(error: unknown) { console.error(error instanceof Error ? error.message : 'OPTIMIZATION_FAILED'); process.exitCode = 2; }
