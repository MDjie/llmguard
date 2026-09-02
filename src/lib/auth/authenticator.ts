import type { NextRequest } from 'next/server';
import type { AuthenticatedPrincipal } from '@/lib/api-security/types';
import { normalizePlatformRole, permissionsForRole } from './authorization';
import { AUTH_COOKIE_NAME, SCOPE_COOKIE_NAME } from './constants';
import { findUserById } from './repository';
import { verifySessionToken } from './session';
import { verifyScopeSession } from './scope-session';
import { APPLICATION_HEADER_NAME, TENANT_HEADER_NAME } from '@/lib/tenancy/context';
import { authenticateApplicationCredential } from '@/lib/tenancy/credentials';
import { resolveUserTenantScope } from '@/lib/tenancy/repository';

const scopeIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

function bearerToken(request: NextRequest): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization) return null;
  const match = authorization.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  return match?.[1] ?? null;
}

export async function authenticateRequest(
  request: NextRequest,
): Promise<AuthenticatedPrincipal | null> {
  const bearer = bearerToken(request);
  const cookie = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const hasApplicationCredential = request.headers.has('x-guard-api-key');
  if (hasApplicationCredential) {
    if (bearer || cookie) return null;
    return authenticateApplicationCredential(request);
  }
  const token = bearer ?? cookie;
  if (!token) return null;

  let claims;
  try {
    claims = verifySessionToken(token);
  } catch {
    return null;
  }

  const user = await findUserById(claims.sub);
  if (!user || user.status !== 'active') return null;
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) return null;
  if (user.tokenVersion !== claims.tokenVersion) return null;

  const role = normalizePlatformRole(user.role);
  if (!role || role !== claims.role) return null;
  const mustChangePassword = Boolean(user.mustChangePassword);
  let requestedTenantId = request.headers.get(TENANT_HEADER_NAME) ?? undefined;
  let requestedApplicationId = request.headers.get(APPLICATION_HEADER_NAME) ?? undefined;
  const hasExplicitScope = Boolean(requestedTenantId || requestedApplicationId);
  const scopeToken = request.cookies.get(SCOPE_COOKIE_NAME)?.value;
  if (!hasExplicitScope && scopeToken) {
    try {
      const scopeClaims = verifyScopeSession(scopeToken);
      if (scopeClaims.sub !== user.id || scopeClaims.tokenVersion !== user.tokenVersion) {
        return null;
      }
      requestedTenantId = scopeClaims.tenantId;
      requestedApplicationId = scopeClaims.applicationId;
    } catch {
      return null;
    }
  }
  if (
    (requestedTenantId && !scopeIdPattern.test(requestedTenantId)) ||
    (requestedApplicationId && !scopeIdPattern.test(requestedApplicationId))
  ) {
    return null;
  }
  const scope = await resolveUserTenantScope(
    user.id,
    requestedTenantId,
    requestedApplicationId,
  );
  if (!scope) return null;

  return {
    subject: user.id,
    roles: [role],
    permissions: permissionsForRole(role, mustChangePassword),
    authenticationMethod: bearer ? 'bearer' : 'cookie',
    tenantId: scope.tenantId,
    applicationId: scope.applicationId,
    tokenVersion: user.tokenVersion,
    mustChangePassword,
  };
}
