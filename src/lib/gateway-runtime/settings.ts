import { readFileSync, statSync } from 'node:fs';
import { GatewayError } from './error';

const files = new Map<string, { modified: number; changed: number; inode: number; size: number; value: string }>();
/** Settings come only from operator-controlled environment or mounted secret files. */
export function gatewaySetting(inlineName: string, fileName: string): string | undefined {
  const inline = process.env[inlineName], path = process.env[fileName];
  if (inline && path) throw new GatewayError('GATEWAY_SETTING_AMBIGUOUS', 503);
  if (inline) { if (Buffer.byteLength(inline) > 1048576) throw new GatewayError('GATEWAY_SETTING_TOO_LARGE', 503); return inline; }
  if (!path) return undefined;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 1048576) throw new GatewayError('GATEWAY_SETTING_TOO_LARGE', 503);
    const cached = files.get(path);
    if (cached?.modified === stat.mtimeMs && cached.changed === stat.ctimeMs && cached.inode === stat.ino && cached.size === stat.size) return cached.value;
    const value = readFileSync(path, 'utf8').trim();
    if (files.size >= 16 && !files.has(path)) files.delete(files.keys().next().value!);
    files.set(path, { modified: stat.mtimeMs, changed: stat.ctimeMs, inode: stat.ino, size: stat.size, value });
    return value;
  } catch (error) { throw error instanceof GatewayError ? error : new GatewayError('GATEWAY_SETTING_UNAVAILABLE', 503); }
}
