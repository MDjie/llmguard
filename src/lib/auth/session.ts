import { randomBytes, randomUUID } from 'node:crypto';
import { sign, verify } from 'jsonwebtoken';
import { z } from 'zod';
import type { PlatformRole } from '@/lib/api-security/types';
import {
  DEFAULT_SESSION_SECONDS,
  REMEMBERED_SESSION_SECONDS,
  SESSION_AUDIENCE,
  SESSION_ISSUER,
} from './constants';

const sessionClaimsSchema = z.object({
  sub: z.string().min(1).max(128),
  jti: z.uuid(),
  username: z.string().min(1).max(50),
  role: z.enum([
    'SYSTEM_ADMIN',
    'SECURITY_ADMIN',
    'AUDIT_ADMIN',
    'BUSINESS_OPERATOR',
    'APP_DEVELOPER',
    'READ_ONLY',
  ]),
  tokenVersion: z.number().int().nonnegative(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  iss: z.literal(SESSION_ISSUER),
  aud: z.union([z.literal(SESSION_AUDIENCE), z.array(z.literal(SESSION_AUDIENCE))]),
});

export interface SessionClaims {
  readonly sub: string;
  readonly jti: string;
  readonly username: string;
  readonly role: PlatformRole;
  readonly tokenVersion: number;
  readonly iat: number;
  readonly exp: number;
  readonly iss: typeof SESSION_ISSUER;
  readonly aud: typeof SESSION_AUDIENCE | readonly (typeof SESSION_AUDIENCE)[];
}

export interface SessionUser {
  readonly id: string;
  readonly username: string;
  readonly role: PlatformRole;
  readonly tokenVersion: number;
}

export interface IssuedSession {
  readonly token: string;
  readonly csrfToken: string;
  readonly maxAgeSeconds: number;
}

export function getJwtSecret(environment: NodeJS.ProcessEnv = process.env): string {
  const secret = environment.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 bytes');
  }
  return secret;
}

export function issueSession(
  user: SessionUser,
  rememberMe: boolean,
  secret = getJwtSecret(),
): IssuedSession {
  const maxAgeSeconds = rememberMe ? REMEMBERED_SESSION_SECONDS : DEFAULT_SESSION_SECONDS;
  const token = sign(
    {
      username: user.username,
      role: user.role,
      tokenVersion: user.tokenVersion,
    },
    secret,
    {
      algorithm: 'HS256',
      audience: SESSION_AUDIENCE,
      issuer: SESSION_ISSUER,
      subject: user.id,
      jwtid: randomUUID(),
      expiresIn: maxAgeSeconds,
    },
  );

  return {
    token,
    csrfToken: randomBytes(32).toString('base64url'),
    maxAgeSeconds,
  };
}

export function verifySessionToken(token: string, secret = getJwtSecret()): SessionClaims {
  const decoded = verify(token, secret, {
    algorithms: ['HS256'],
    audience: SESSION_AUDIENCE,
    issuer: SESSION_ISSUER,
  });
  return sessionClaimsSchema.parse(decoded) as SessionClaims;
}
