import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from './constants';

export function csrfHeaders(): Readonly<Record<string, string>> {
  if (typeof document === 'undefined') return {};
  const prefix = `${CSRF_COOKIE_NAME}=`;
  const value = document.cookie
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length);
  return value ? { [CSRF_HEADER_NAME]: decodeURIComponent(value) } : {};
}
