import type { NextResponse } from 'next/server';
import type { IssuedSession } from './session';
import { AUTH_COOKIE_NAME, CSRF_COOKIE_NAME, SCOPE_COOKIE_NAME } from './constants';

function secureCookies(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function setSessionCookies(response: NextResponse, session: IssuedSession): void {
  response.cookies.set(AUTH_COOKIE_NAME, session.token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'strict',
    maxAge: session.maxAgeSeconds,
    path: '/',
  });
  response.cookies.set(CSRF_COOKIE_NAME, session.csrfToken, {
    httpOnly: false,
    secure: secureCookies(),
    sameSite: 'strict',
    maxAge: session.maxAgeSeconds,
    path: '/',
  });
}

export function clearSessionCookies(response: NextResponse): void {
  response.cookies.set(AUTH_COOKIE_NAME, '', {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'strict',
    maxAge: 0,
    path: '/',
  });
  response.cookies.set(CSRF_COOKIE_NAME, '', {
    httpOnly: false,
    secure: secureCookies(),
    sameSite: 'strict',
    maxAge: 0,
    path: '/',
  });
  clearScopeCookie(response);
}

export function setScopeCookie(
  response: NextResponse,
  session: { token: string; maxAgeSeconds: number },
): void {
  response.cookies.set(SCOPE_COOKIE_NAME, session.token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'strict',
    maxAge: session.maxAgeSeconds,
    path: '/',
  });
}

export function clearScopeCookie(response: NextResponse): void {
  response.cookies.set(SCOPE_COOKIE_NAME, '', {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'strict',
    maxAge: 0,
    path: '/',
  });
}
