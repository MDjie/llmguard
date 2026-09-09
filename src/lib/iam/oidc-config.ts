import { z } from 'zod';
import { ApiProblem } from '@/lib/api-security/problem';

export function oidcSettings(environment: Readonly<Record<string,string|undefined>> = process.env) {
  const issuer = environment.IAM_OIDC_ISSUER;
  const clientId = environment.IAM_OIDC_CLIENT_ID;
  const clientSecret = environment.IAM_OIDC_CLIENT_SECRET;
  const redirectUri = environment.IAM_OIDC_REDIRECT_URI;
  if (!issuer || !clientId || !clientSecret || !redirectUri) {
    throw new ApiProblem({ status: 503, code: 'OIDC_NOT_CONFIGURED', title: '企业登录尚未配置', detail: '请联系管理员完成身份平台配置。' });
  }
  const allowHttp = environment.NODE_ENV !== 'production' && environment.IAM_OIDC_ALLOW_LOCAL_HTTP === 'true';
  for (const value of [issuer, redirectUri]) {
    const url = new URL(z.url().parse(value));
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) {
      throw new Error('OIDC URLs require HTTPS without credentials, query or fragment');
    }
  }
  if (new URL(redirectUri).pathname !== '/api/auth/oidc/callback') throw new Error('Invalid OIDC callback path');
  const mfaAcr = environment.IAM_OIDC_MFA_ACR?.trim();
  if (!mfaAcr) throw new Error('IAM_OIDC_MFA_ACR must identify a realm-enforced MFA authentication level');
  return { issuer, clientId, clientSecret, redirectUri, allowHttp, mfaAcr };
}

export function oidcMfaSatisfied(claims: { acr?: unknown }, expectedAcr: string): boolean {
  // The configured ACR must be issued by a flow that enforces two factors.
  return typeof claims.acr === 'string' && claims.acr === expectedAcr;
}

export function landingForRole(role: string): string {
  if (role === 'SYSTEM_ADMIN') return '/users';
  if (role === 'AUDIT_ADMIN') return '/iam-approvals';
  if (role === 'READ_ONLY') return '/dashboard';
  return '/';
}
