import { authenticatedApi } from './auth.mjs';
import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const out = resolve(process.argv[2] ?? '');
const fixture = JSON.parse(readFileSync(out + '/fixture.private.json', 'utf8'));
if (fixture.dataset !== 'SYNTHETIC_ONLY_NEW_EMPTY_DATABASE' || fixture.baseURL !== 'http://127.0.0.1:58089') throw new Error('ISOLATED_FIXTURE_REQUIRED');
mkdirSync(out + '/screenshots', { recursive: true });
const browser = await chromium.launch({ headless: true });
const session = await authenticatedApi(out);
const context = await browser.newContext({ storageState: session.state, baseURL: fixture.baseURL, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const requests = [], errors = [], results = [];
page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/api/')) requests.push({ path: url.pathname, method: response.request().method(), status: response.status() }); });
page.on('pageerror', error => errors.push(error.message.slice(0, 400)));
try {
  const paths = ['/', '/dashboard', '/security-alerts', '/conversations', '/document-scan', '/applications', '/dimensions', '/whitelist', '/policies', '/dictionaries', '/response-templates', '/policy-releases', '/providers', '/test-cases', '/evaluation-runs', '/incidents', '/gateway-requests', '/history', '/agent-logs', '/operations', '/export', '/simulate', '/model-eval'];
  for (const path of paths) {
    const start = requests.length, beforeErrors = errors.length, started = Date.now();
    let failure;
    try {
      const response = await page.goto(path); const expected = ['/simulate', '/model-eval'].includes(path) ? 404 : 200; expect(response?.status()).toBe(expected);
      await page.waitForURL(url => url.pathname === path);
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      if (expected === 200) await expect(page.locator('main')).toBeVisible(); else await expect(page.locator('body')).toHaveText('Not found');
    } catch (error) { failure = error.message.slice(0, 300); }
    const main = page.locator('main');
    const state = await main.evaluate(element => ({
      headings: [...element.querySelectorAll('h1,h2,h3')].map(item => item.textContent?.trim()),
      buttons: [...element.querySelectorAll('button')].map(item => ({ text: item.textContent?.trim().slice(0, 100), label: item.getAttribute('aria-label'), title: item.getAttribute('title'), disabled: item.disabled })),
      inputs: [...element.querySelectorAll('input,textarea,select')].map(item => ({ tag: item.tagName, type: item.getAttribute('type'), id: item.id, placeholder: item.getAttribute('placeholder'), label: item.getAttribute('aria-label') })),
      bodyPreview: element.textContent?.trim().slice(0, 2500),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    })).catch(() => ({}));
    const observed = requests.slice(start), uncaught = errors.slice(beforeErrors);
    const status = !failure && uncaught.length === 0 && observed.every(item => item.status < 400) ? 'PASS' : 'FAIL';
    const result = { id: 'CRAWL:' + path, status, path, actualPath: new URL(page.url()).pathname, milliseconds: Date.now() - started, failure, api: observed, pageErrors: uncaught, state };
    results.push(result);
    await page.screenshot({ path: out + '/screenshots/crawl-' + (path.slice(1) || 'chat') + '.png', fullPage: true, animations: 'disabled' });
    writeFileSync(out + '/crawl.json', JSON.stringify({ scope: 'REAL_FRONTEND_AND_BACKEND_SYNTHETIC_DATABASE', results }, null, 2));
    console.log(JSON.stringify({ path, failure: Boolean(failure), apiErrors: observed.filter(r => r.status >= 400), pageErrors: uncaught.length, headings: state.headings }));
  }
} finally { await browser.close(); await session.api.dispose(); }
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
