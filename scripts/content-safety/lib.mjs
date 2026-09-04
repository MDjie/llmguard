import { createHash } from 'node:crypto';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

export function resolveProjectPath(relativePath) {
  const absolutePath = path.resolve(PROJECT_ROOT, relativePath);
  const relative = path.relative(PROJECT_ROOT, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path escapes project root: ' + relativePath);
  }
  return absolutePath;
}

export async function readJson(relativePath) {
  const content = await readFile(resolveProjectPath(relativePath), 'utf8');
  return JSON.parse(content);
}

export async function readJsonLines(relativePath) {
  const content = await readFile(resolveProjectPath(relativePath), 'utf8');
  const records = [];
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(relativePath + ':' + (index + 1) + ' is invalid JSON: ' + message);
    }
  }
  return records;
}

export async function writeJson(relativePath, value) {
  const absolutePath = resolveProjectPath(relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export async function writeJsonLines(relativePath, records) {
  const absolutePath = resolveProjectPath(relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const content = records.map((record) => JSON.stringify(record)).join('\n');
  await writeFile(absolutePath, content + (content ? '\n' : ''), 'utf8');
}

export async function sha256File(relativePath) {
  const content = await readFile(resolveProjectPath(relativePath));
  return createHash('sha256').update(content).digest('hex');
}

export function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function assertRegularFile(relativePath) {
  const fileStat = await stat(resolveProjectPath(relativePath));
  if (!fileStat.isFile()) {
    throw new Error('Expected a regular file: ' + relativePath);
  }
  return fileStat;
}

export function normalizedKey(value) {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

export function asNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(fieldName + ' must be a non-empty string');
  }
  return value;
}
