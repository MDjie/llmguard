import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const apiRoot = join(process.cwd(), 'src', 'app', 'api');
const workloadRoutes = new Set([
  'internal/gateway/authorize/route.ts', 'internal/gateway/evaluate/route.ts',
  'internal/gateway/events/route.ts', 'internal/gateway/runtime/ack/route.ts',
  'internal/gateway/runtime/route.ts',
]);
const publicRoutes = new Set([
  'auth/login/route.ts',
  'health/db/route.ts',
  'health/policy/route.ts',
  'health/live/route.ts',
  'health/route.ts',
]);

function routeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === 'route.ts' ? [path] : [];
  });
}

function routeName(file) {
  return relative(apiRoot, file).split(sep).join('/');
}

describe('API route security inventory', () => {
  const routes = routeFiles(apiRoot);

  it('requires every exported HTTP method to use the shared security boundary', () => {
    const violations = [];
    for (const file of routes) {
      const source = readFileSync(file, 'utf8');
      const exports = [...source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\s*=/g)];
      const workload = workloadRoutes.has(routeName(file));
      const secured = [...source.matchAll(workload
        ? /export const (GET|POST|PUT|PATCH|DELETE)\s*=\s*internalGatewayRoute\s*\(/g
        : /export const (GET|POST|PUT|PATCH|DELETE)\s*=\s*with(?:Legacy)?ApiSecurity\s*\(/g)];
      if (workload && !source.includes("from '@/lib/gateway-runtime/http'")) {
        violations.push(`${routeName(file)}: workload boundary import is missing`);
      }
      if (exports.length === 0 || secured.length !== exports.length) {
        violations.push(`${routeName(file)}: exported=${exports.length}, secured=${secured.length}`);
      }
      if (/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)/.test(source)) {
        violations.push(`${routeName(file)}: raw function export`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('allows anonymous access only for the explicit public-route allowlist', () => {
    const declaredPublic = routes
      .filter((file) => /public\s*:\s*true/.test(readFileSync(file, 'utf8')))
      .map(routeName)
      .sort();
    expect(declaredPublic).toEqual([...publicRoutes].sort());
  });

  it('does not initialize schema or seed data from ordinary request routes', () => {
    const violations = routes
      .filter((file) => /\b(?:initializeDatabase|initDefaultPolicy)\b/.test(readFileSync(file, 'utf8')))
      .map(routeName);
    expect(violations).toEqual([]);
  });
});
