import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
}
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const digestObject = (value: unknown): string => sha256(canonical(value));
export async function fileHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function* jsonLines(file: string): AsyncGenerator<unknown> {
  let lineNumber = 0;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    lineNumber++;
    if (!line.trim()) continue;
    try { yield JSON.parse(lineNumber === 1 ? line.replace(/^\uFEFF/u, '') : line) as unknown; }
    catch { throw new Error('INVALID_JSON_LINE:' + lineNumber); }
  }
}
export async function readJson(file: string): Promise<unknown> {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, '')) as unknown;
}
export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
export async function newOutputDirectory(directory: string): Promise<void> {
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory); // Existing directories are never reused or overwritten.
}
export function required(value: string | undefined, name: string): string {
  if (!value) throw new Error('ARGUMENT_REQUIRED:' + name);
  return value;
}
export function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('POSITIVE_INTEGER_REQUIRED');
  return parsed;
}
export async function codeIdentity(extraAssets: readonly string[] = []): Promise<{ codeHash: string; files: { path: string; sha256: string }[]; gitRevision: string }> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', '.next'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|wasm)$/u.test(entry.name)) files.push(file);
    }
  }
  for (const name of ['src', 'packages', 'scripts/independent-acceptance']) await walk(path.join(projectRoot, name));
  // Fingerprint static JSON imports outside src, including taxonomy and injection catalogs.
  for (const file of [...files]) {
    if (!/\.(?:ts|tsx|mts|js|mjs)$/u.test(file)) continue;
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/\bfrom\s*['"](\.[^'"]+\.json)['"]/gu)) files.push(path.resolve(path.dirname(file), match[1]));
  }
  for (const file of extraAssets) files.push(path.resolve(file));
  for (const name of ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'node_modules/.pnpm/lock.yaml']) files.push(path.join(projectRoot, name));
  const entries = [];
  for (const file of [...new Set(files)].sort()) entries.push({ path: path.relative(projectRoot, file).split(path.sep).join('/'), sha256: await fileHash(file) });
  let gitRevision = 'UNAVAILABLE';
  try { gitRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Content hashes remain authoritative. */ }
  return { codeHash: digestObject(entries), files: entries, gitRevision };
}
export function fail(error: unknown): void {
  // Never print raw provider exceptions, request bodies, or secrets.
  const message = error instanceof Error && /^[A-Z0-9_:.-]+$/u.test(error.message) ? error.message : 'ACCEPTANCE_FAILED_SEE_LOCAL_DIAGNOSTICS';
  console.error(JSON.stringify({ status: 'FAILED', reason: message }));
  process.exitCode = 1;
}
