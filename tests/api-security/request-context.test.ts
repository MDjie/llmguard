import { describe, expect, it } from 'vitest';
import {
  parseTrustedProxies,
  resolveClientIp,
} from '../../src/lib/api-security/request-context';

function headers(entries: Readonly<Record<string, string>>): {
  get(name: string): string | null;
} {
  return {
    get(name: string): string | null {
      for (const [key, value] of Object.entries(entries)) {
        if (key.toLowerCase() === name.toLowerCase()) return value;
      }
      return null;
    },
  };
}

const DIRECT: Readonly<Record<string, string>> = { 'x-guardllm-remote': '203.0.113.7' };
const VIA_PROXY: Readonly<Record<string, string>> = { 'x-guardllm-remote': '10.0.0.5' };
const PROXIES = parseTrustedProxies('10.0.0.5,172.18.0.0/16');

describe('resolveClientIp', () => {
  it('returns the TCP peer address for direct connections and ignores forgeable headers', () => {
    expect(resolveClientIp(headers({
      ...DIRECT,
      'x-forwarded-for': '6.6.6.6',
      'x-real-ip': '7.7.7.7',
    }), [])).toBe('203.0.113.7');
  });

  it('returns unknown when no trusted remote header exists (fail-closed)', () => {
    expect(resolveClientIp(headers({
      'x-forwarded-for': '6.6.6.6',
      'x-real-ip': '7.7.7.7',
    }), PROXIES)).toBe('unknown');
  });

  it('walks x-forwarded-for from the right when the peer is a trusted proxy', () => {
    expect(resolveClientIp(headers({
      ...VIA_PROXY,
      'x-forwarded-for': 'spoofed.by.client, 198.51.100.23, 10.0.0.5',
    }), PROXIES)).toBe('198.51.100.23');
  });

  it('returns the proxy address itself when the proxy did not append xff', () => {
    expect(resolveClientIp(headers(VIA_PROXY), PROXIES)).toBe('10.0.0.5');
  });

  it('matches trusted proxies by IPv4 CIDR', () => {
    expect(resolveClientIp(headers({
      'x-guardllm-remote': '172.18.9.99',
      'x-forwarded-for': '198.51.100.23, 172.18.9.99',
    }), PROXIES)).toBe('198.51.100.23');
  });

  it('does not treat a similar-but-untrusted subnet as a proxy', () => {
    expect(resolveClientIp(headers({
      'x-guardllm-remote': '172.19.0.1',
      'x-forwarded-for': '6.6.6.6',
    }), PROXIES)).toBe('172.19.0.1');
  });

  it('normalizes IPv6-mapped IPv4 and loopback addresses', () => {
    expect(resolveClientIp(headers({
      'x-guardllm-remote': '::ffff:10.0.0.5',
      'x-forwarded-for': '198.51.100.23',
    }), PROXIES)).toBe('198.51.100.23');
    expect(resolveClientIp(headers({
      'x-guardllm-remote': '::1',
      'x-forwarded-for': '6.6.6.6',
    }), PROXIES)).toBe('127.0.0.1');
  });

  it('returns the leftmost hop when every hop claims to be a trusted proxy', () => {
    expect(resolveClientIp(headers({
      ...VIA_PROXY,
      'x-forwarded-for': '10.0.0.5, 10.0.0.5',
    }), PROXIES)).toBe('10.0.0.5');
  });

  it('truncates oversized addresses instead of trusting them', () => {
    const oversized = `${'a'.repeat(80)}:1`;
    expect(resolveClientIp(headers({ 'x-guardllm-remote': oversized }), [])).toBe('unknown');
  });
});
