import { randomBytes, randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import type { RequestContext } from './types';

const TRACEPARENT_PATTERN = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}(?:-[\x20-\x7e]+)?$/i;

/**
 * 由自定义服务器（src/server.ts）在 TCP 层写入的对端地址头。
 * 客户端传入的同名头会被无条件覆盖，因此它是唯一可信的来源；
 * x-forwarded-for / x-real-ip 等头仅在确认对端是可信代理后才参与解析。
 */
const REMOTE_ADDRESS_HEADER = 'x-guardllm-remote';

type ProxyPattern =
  | { readonly kind: 'exact'; readonly value: string }
  | { readonly kind: 'cidr4'; readonly base: number; readonly mask: number };

function traceIdFrom(request: NextRequest): string {
  const traceparent = request.headers.get('traceparent');
  const match = traceparent?.match(TRACEPARENT_PATTERN);
  const candidate = match?.[1]?.toLowerCase();

  if (candidate && candidate !== '00000000000000000000000000000000') {
    return candidate;
  }

  return randomBytes(16).toString('hex');
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function normalizeIp(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  let value = candidate.trim().toLowerCase();
  if (!value) return null;
  // IPv6 映射的 IPv4（::ffff:1.2.3.4）与回环地址统一归一化，便于与信任配置比对
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    if (ipv4ToNumber(mapped) !== null) value = mapped;
  }
  if (value === '::1') value = '127.0.0.1';
  return value.length <= 64 ? value : null;
}

export function parseTrustedProxies(raw: string | undefined): readonly ProxyPattern[] {
  if (!raw) return [];
  const patterns: ProxyPattern[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.includes('/')) {
      const [network, bitsRaw] = trimmed.split('/');
      const base = network === undefined ? null : ipv4ToNumber(network);
      const bits = /^\d{1,2}$/.test(bitsRaw ?? '') ? Number(bitsRaw) : Number.NaN;
      if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
        console.warn(`[api-security] 忽略无效的 TRUSTED_PROXIES 条目: ${trimmed}`);
        continue;
      }
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      patterns.push({ kind: 'cidr4', base: base & mask, mask });
    } else {
      const normalized = normalizeIp(trimmed);
      if (!normalized) {
        console.warn(`[api-security] 忽略无效的 TRUSTED_PROXIES 条目: ${trimmed}`);
        continue;
      }
      patterns.push({ kind: 'exact', value: normalized });
    }
  }
  return patterns;
}

let cachedTrustedProxies: readonly ProxyPattern[] | undefined;

function defaultTrustedProxies(): readonly ProxyPattern[] {
  cachedTrustedProxies ??= parseTrustedProxies(process.env.TRUSTED_PROXIES);
  return cachedTrustedProxies;
}

function isTrustedProxy(ip: string, patterns: readonly ProxyPattern[]): boolean {
  for (const pattern of patterns) {
    if (pattern.kind === 'exact') {
      if (ip === pattern.value) return true;
      continue;
    }
    const candidate = ipv4ToNumber(ip);
    if (candidate !== null && (candidate & pattern.mask) === pattern.base) return true;
  }
  return false;
}

/**
 * 解析客户端真实 IP：
 * 1. 优先取自定义服务器写入的 TCP 对端地址（客户端不可伪造）；
 * 2. 对端不是可信代理时，直接返回对端地址，完全忽略 XFF 等可伪造头；
 * 3. 对端是可信代理（TRUSTED_PROXIES 配置）时，从 XFF 右侧起跳过
 *    可信代理追加的地址，取第一个不可信地址作为客户端 IP。
 */
export function resolveClientIp(
  headers: { get(name: string): string | null },
  trustedProxies: readonly ProxyPattern[] = defaultTrustedProxies(),
): string {
  const remote = normalizeIp(headers.get(REMOTE_ADDRESS_HEADER));
  if (!remote) {
    // 未经过自定义服务器入口（如 next start / 部分托管环境）时没有任何可信来源，
    // 不退回可伪造头，保持 fail-closed
    return 'unknown';
  }
  if (!isTrustedProxy(remote, trustedProxies)) return remote;
  const forwarded = headers.get('x-forwarded-for');
  if (!forwarded) return remote;
  const hops = forwarded
    .split(',')
    .map((hop) => normalizeIp(hop))
    .filter((hop): hop is string => hop !== null);
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    if (!isTrustedProxy(hops[index], trustedProxies)) return hops[index];
  }
  return hops[0] ?? remote;
}

function clientIpFrom(request: NextRequest): string {
  return resolveClientIp(request.headers);
}

export function createRequestContext(
  request: NextRequest,
  now: () => number,
): RequestContext {
  const search = request.nextUrl.search;
  return {
    requestId: randomUUID(),
    traceId: traceIdFrom(request),
    startedAt: now(),
    method: request.method.toUpperCase(),
    path: request.nextUrl.pathname,
    // query 串用于审计追溯目标资源（如 ?id=xxx），截断到列宽上限
    ...(search ? { queryString: search.slice(0, 1_024) } : {}),
    clientIp: clientIpFrom(request),
    ...(request.headers.get('user-agent')
      ? { userAgent: request.headers.get('user-agent')?.slice(0, 256) }
      : {}),
  };
}
