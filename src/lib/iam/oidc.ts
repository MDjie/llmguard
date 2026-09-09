import { createHash, randomBytes } from 'node:crypto';
import * as oidc from 'openid-client';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/storage/database/shared/db';
import { users } from '@/storage/database/shared/schema';
import { issueSession } from '@/lib/auth/session';
import { clearScopeCookie, secureCookies, setSessionCookies } from '@/lib/auth/cookies';
import { normalizePlatformRole } from '@/lib/auth/authorization';
import { resolveUserTenantScope } from '@/lib/tenancy/repository';
import { iamIdentityProfiles, iamOidcExchanges } from './schema';
import { denied } from './grants';
import { auditIam } from './management';
import { oidcMfaSatisfied, oidcSettings, landingForRole } from './oidc-config';

const cookieName = 'guardllm_oidc_binding';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function configuration(settings: ReturnType<typeof oidcSettings>) {
  const config = await oidc.discovery(new URL(settings.issuer), settings.clientId, settings.clientSecret,
    undefined, { timeout: 10, ...(settings.allowHttp ? { execute: [oidc.allowInsecureRequests] } : {}) });
  oidc.enableNonRepudiationChecks(config);
  const metadata = config.serverMetadata();
  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) {
    if (!endpoint || new URL(endpoint).origin !== new URL(settings.issuer).origin) throw new Error('OIDC endpoint origin mismatch');
  }
  return config;
}

export async function beginOidc() {
  const settings = oidcSettings();
  const config = await configuration(settings);
  const state = oidc.randomState();
  const binding = randomBytes(32).toString('base64url');
  const verifier = oidc.randomPKCECodeVerifier();
  const nonce = oidc.randomNonce();
  await db.delete(iamOidcExchanges).where(lt(iamOidcExchanges.expiresAt, new Date()));
  await db.insert(iamOidcExchanges).values({ id: state, browserHash: hash(binding), verifier, nonce,
    expiresAt: new Date(Date.now() + 5 * 60_000) });
  const url = oidc.buildAuthorizationUrl(config, { redirect_uri: settings.redirectUri, scope: 'openid',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
    state, nonce, acr_values: settings.mfaAcr, max_age: '300',
    claims: JSON.stringify({ id_token: { acr: { essential: true, values: [settings.mfaAcr] } } }) });
  const response = NextResponse.redirect(url, 303);
  response.cookies.set(cookieName, binding, { httpOnly: true, secure: secureCookies(), sameSite: 'lax',
    maxAge: 300, path: '/api/auth/oidc' });
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}

export async function finishOidc(request: NextRequest) {
  const settings = oidcSettings();
  const state = request.nextUrl.searchParams.get('state');
  const binding = request.cookies.get(cookieName)?.value;
  if (!state || !binding || state.length > 64 || binding.length > 128) throw denied('OIDC_STATE_INVALID', 401);
  // Atomic consume binds the exchange to this browser and makes replay fail closed.
  const [exchange] = await db.update(iamOidcExchanges).set({ consumedAt: new Date() }).where(and(
    eq(iamOidcExchanges.id,state), eq(iamOidcExchanges.browserHash,hash(binding)),
    isNull(iamOidcExchanges.consumedAt), gt(iamOidcExchanges.expiresAt,new Date()))).returning();
  if (!exchange) throw denied('OIDC_STATE_INVALID',401);
  const config = await configuration(settings);
  const callback = new URL(settings.redirectUri);
  callback.search = request.nextUrl.search;
  const tokens = await oidc.authorizationCodeGrant(config,callback,{
    expectedState: state, expectedNonce: exchange.nonce, pkceCodeVerifier: exchange.verifier,
    idTokenExpected: true, maxAge: 300,
  });
  const claims = tokens.claims();
  if (!claims || !oidcMfaSatisfied({acr:claims.acr},settings.mfaAcr)) throw denied('OIDC_MFA_REQUIRED',403);
  const [match] = await db.select({ user:users, identity:iamIdentityProfiles }).from(iamIdentityProfiles)
    .innerJoin(users,eq(users.id,iamIdentityProfiles.userId)).where(and(
      eq(iamIdentityProfiles.issuer,settings.issuer),eq(iamIdentityProfiles.subject,claims.sub),
      eq(iamIdentityProfiles.loginMethod,'oidc')));
  if (!match || match.user.status !== 'active' || (match.user.lockedUntil && match.user.lockedUntil > new Date())) {
    throw denied('OIDC_ACCOUNT_NOT_PROVISIONED',403);
  }
  const role = normalizePlatformRole(match.user.role);
  const scope = await resolveUserTenantScope(match.user.id);
  if (!role || !scope) throw denied('ACCOUNT_SCOPE_UNAVAILABLE',403);
  const lifetime = Math.min(3600, Math.floor(claims.exp - Date.now()/1000));
  if (lifetime < 1) throw denied('OIDC_TOKEN_EXPIRED',401);
  await db.transaction(async tx => {
    await tx.update(users).set({ lastLoginAt:new Date(), loginCount:sql`${users.loginCount}+1`,
      failedLoginCount:0,lockedUntil:null }).where(eq(users.id,match.user.id));
    await auditIam(tx,{...scope,principalId:match.user.id},'auth.oidc.success',match.user.id,{issuer:settings.issuer,authenticationStrength:'mfa'});
  });
  const response = NextResponse.redirect(new URL(landingForRole(role),settings.redirectUri),303);
  setSessionCookies(response,issueSession({id:match.user.id,username:match.user.username,role,
    tokenVersion:match.user.tokenVersion,authenticationStrength:'mfa',identityProvider:settings.issuer,maxAgeSeconds:lifetime},false));
  clearScopeCookie(response);
  response.cookies.set(cookieName,'',{httpOnly:true,secure:secureCookies(),sameSite:'lax',maxAge:0,path:'/api/auth/oidc'});
  response.headers.set('cache-control','no-store');
  response.headers.set('referrer-policy','no-referrer');
  return response;
}
