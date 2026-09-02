import { randomUUID } from 'node:crypto';
import { sign, verify } from 'jsonwebtoken';
import { z } from 'zod';
import {
  DEFAULT_SESSION_SECONDS,
  SCOPE_SESSION_AUDIENCE,
  SESSION_ISSUER,
} from './constants';
import { getJwtSecret } from './session';
import type { TenantScope } from '@/lib/tenancy/context';

const scopeClaimsSchema = z.object({
  sub: z.string().min(1).max(128),
  jti: z.uuid(),
  tenantId: z.string().min(1).max(128),
  applicationId: z.string().min(1).max(128),
  tokenVersion: z.number().int().nonnegative(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  iss: z.literal(SESSION_ISSUER),
  aud: z.union([
    z.literal(SCOPE_SESSION_AUDIENCE),
    z.array(z.literal(SCOPE_SESSION_AUDIENCE)),
  ]),
});

export interface ScopeSessionClaims extends TenantScope {
  readonly sub: string;
  readonly tokenVersion: number;
  readonly exp: number;
}

export function issueScopeSession(
  user: { id: string; tokenVersion: number },
  scope: TenantScope,
  secret = getJwtSecret(),
): { token: string; maxAgeSeconds: number } {
  const token = sign(
    {
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      tokenVersion: user.tokenVersion,
    },
    secret,
    {
      algorithm: 'HS256',
      audience: SCOPE_SESSION_AUDIENCE,
      issuer: SESSION_ISSUER,
      subject: user.id,
      jwtid: randomUUID(),
      expiresIn: DEFAULT_SESSION_SECONDS,
    },
  );
  return { token, maxAgeSeconds: DEFAULT_SESSION_SECONDS };
}

export function verifyScopeSession(
  token: string,
  secret = getJwtSecret(),
): ScopeSessionClaims {
  const decoded = verify(token, secret, {
    algorithms: ['HS256'],
    audience: SCOPE_SESSION_AUDIENCE,
    issuer: SESSION_ISSUER,
  });
  return scopeClaimsSchema.parse(decoded) as ScopeSessionClaims;
}
