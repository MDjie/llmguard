import { request } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
export async function authenticatedApi(out, kind = 'owner') {
 const f = JSON.parse(readFileSync(out + '/fixture.private.json', 'utf8'));
 if (f.dataset !== 'SYNTHETIC_ONLY_NEW_EMPTY_DATABASE' || f.baseURL !== 'http://127.0.0.1:58089') throw new Error('ISOLATED_FIXTURE_REQUIRED');
 const credentials = kind === 'owner' ? f : f[kind]; if (!credentials) throw new Error('TEST_SUBJECT_MISSING_' + kind);
 const state = out + (kind === 'owner' ? '/browser-state.private.json' : `/browser-${kind}.private.json`);
 const api = await request.newContext({ baseURL: f.baseURL, ...(existsSync(state) ? { storageState: state } : {}) });
 if ((await api.get('/api/auth/me')).status() !== 200) {
  for (let attempt = 0; attempt < 3; attempt++) {
   const response = await api.post('/api/auth/login', { data: { username: credentials.username, password: credentials.password } });
   if (response.status() === 200) break;
   if (response.status() !== 429 || attempt === 2) { await api.dispose(); throw new Error('LOGIN_FAILED_' + response.status()); }
   const seconds = Number(response.headers()['retry-after']); if (!Number.isFinite(seconds) || seconds < 1 || seconds > 901) throw new Error('INVALID_RETRY_AFTER');
   const until = Date.now() + (seconds + 1) * 1000;
   while (Date.now() < until) { console.log('LOGIN_RATE_LIMIT_WAIT_' + Math.ceil((until-Date.now())/1000)); await new Promise(resolve => setTimeout(resolve, Math.min(30000, until-Date.now()))); }
  }
  await api.storageState({ path: state });
 }
 const csrf = (await api.storageState()).cookies.find(cookie => cookie.name === 'csrf-token')?.value;
 if (!csrf) throw new Error('CSRF_MISSING');
 return { api, state, headers: { 'x-csrf-token': csrf, origin: f.baseURL }, fixture: f };
}
