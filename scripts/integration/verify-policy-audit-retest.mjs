import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect as baseExpect } from '@playwright/test';
import { authenticatedApi } from './comprehensive/auth.mjs';

const expect = baseExpect.configure({ timeout: 15000 });
const out = resolve(process.argv[2] ?? '');
const setup = JSON.parse(readFileSync(out + '/trial-setup.json', 'utf8'));
assert.equal(setup.source, 'SYNTHETIC_DATABASE_BACKUP');
assert.equal(setup.database, 'guardllm_report_retest_20260909');
const { api, headers, fixture } = await authenticatedApi(out);
const checks = [], errors = [];
const record = (id, detail) => { checks.push({ id, status: 'PASS', detail }); console.log(id + ' PASS'); };
const json = async (response, status = 200) => { assert.equal(response.status(), status); return response.json(); };
const bundles = async () => (await json(await api.get('/api/policy-bundles?policyId=' + fixture.policyId))).data;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL: fixture.baseURL, storageState: await api.storageState(), viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(15000);
try {
  const before = (await json(await api.get('/api/policy-runtime'))).data;
  assert.equal(before.signatureVerified, true);
  const old = await bundles();
  assert.ok(old.some(bundle => bundle.sourcePolicyVersion === null));
  record('LEGACY_SIGNATURE_AND_UNKNOWN_SOURCE_PRESERVED');

  const policy = (await json(await api.get('/api/policies/' + fixture.policyId))).data;
  const compile = async () => (await json(await api.post('/api/policy-bundles', { headers, data: { policyId: fixture.policyId } }), 201)).data;
  const first = await compile(), second = await compile();
  assert.equal(first.canonicalJson.sourcePolicyVersion, policy.version);
  assert.equal(second.version, first.version + 1);
  assert.equal(first.signingKeyId, second.signingKeyId);
  assert.notEqual(first.contentHash, second.contentHash);
  assert.notEqual(first.signature, second.signature);
  const same = (await bundles()).filter(bundle => [first.id, second.id].includes(bundle.id));
  assert.ok(same.every(bundle => bundle.draftComparison === 'current'));
  assert.equal(same[0].configurationDigest, same[1].configurationDigest);
  record('SOURCE_VERSION_PACKAGE_SEQUENCE_AND_DIGEST', { source: policy.version, packages: [first.version, second.version] });

  const rule = policy.rules.find(item => item.enabled);
  assert.ok(rule);
  await json(await api.put('/api/policies', { headers, data: { policyId: fixture.policyId, rules: [{
    id: rule.id, dimension: rule.dimension, enabled: true, warn_enabled: true, block_enabled: true,
    warn_threshold: 25, block_threshold: Number(rule.block_threshold) === 55 ? 65 : 55, auto_mask: false, auto_rewrite: false,
  }] } }));
  const revised = (await json(await api.get('/api/policies/' + fixture.policyId))).data;
  assert.equal(revised.version, policy.version + 1);
  const changed = (await bundles()).find(bundle => bundle.id === second.id);
  assert.equal(changed.draftComparison, 'changed');
  const third = await compile();
  assert.equal(third.canonicalJson.sourcePolicyVersion, revised.version);
  assert.equal((await bundles()).find(bundle => bundle.id === third.id).draftComparison, 'current');
  record('SAVED_RULE_CHANGES_REQUIRE_RECOMPILATION');

  const after = (await json(await api.get('/api/policy-runtime'))).data;
  assert.equal(after.binding.active.id, before.binding.active.id);
  assert.equal(after.generation, before.generation);
  assert.equal(after.signatureVerified, true);
  record('COMPILATION_DOES_NOT_PUBLISH');

  await page.goto('/policies/' + fixture.policyId);
  await expect(page.getByRole('link', { name: '查看签名包与发布状态' })).toBeVisible();
  await expect(page.getByText('当前配置与全量包内容不同，修改尚未全量生效。')).toBeVisible();
  await page.screenshot({ path: out + '/policy-source-version.png', fullPage: true });
  await page.getByRole('link', { name: '查看签名包与发布状态' }).click();
  await page.waitForURL('**/policy-releases?policyId=*', { timeout: 30000 });
  await expect(page.getByText('内容摘要与签名密钥', { exact: true })).toBeVisible();
  await expect(page.getByText('签名密钥 ID：' + first.signingKeyId).first()).toBeVisible();
  await expect(page.getByText(first.contentHash, { exact: true })).toBeVisible();
  await page.screenshot({ path: out + '/policy-release-identities.png', fullPage: true });
  record('POLICY_PAGES_SHOW_COMPLETE_IDENTITIES_AND_LIVE_BINDING');

  const requestId = 'report-retest-request';
  const redirect = await api.get('/conversations?request=' + requestId, { maxRedirects: 0 });
  assert.ok([200, 307].includes(redirect.status()));
  if (redirect.status() === 307) assert.equal(new URL(redirect.headers().location, fixture.baseURL).searchParams.get('request'), requestId);
  else assert.ok((await redirect.text()).includes('/history?view=archives')); // Next streaming redirect
  await page.goto('/conversations?request=' + requestId);
  await page.waitForURL('**/history?view=archives&request=' + requestId);
  await expect(page.getByRole('tab', { name: '对话归档', exact: true })).toHaveAttribute('data-state', 'active');
  await expect(page.getByRole('textbox', { name: '筛选请求 ID' })).toHaveValue(requestId);
  assert.equal(await page.locator('a[href="/conversations"]').count(), 0);
  await page.getByRole('tab', { name: '检测记录', exact: true }).click();
  await expect(page.getByRole('tab', { name: '检测记录', exact: true })).toHaveAttribute('data-state', 'active');
  await page.goBack();
  await expect(page.getByRole('tab', { name: '对话归档', exact: true })).toHaveAttribute('data-state', 'active');
  await page.screenshot({ path: out + '/unified-audit.png', fullPage: true });
  record('AUDIT_TABS_LEGACY_REDIRECT_AND_BROWSER_HISTORY');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/history?view=archives');
  await expect(page.getByRole('tab', { name: '对话归档', exact: true })).toHaveAttribute('data-state', 'active');
  await page.getByRole('tab', { name: '检测记录', exact: true }).click();
  await expect(page.getByRole('tab', { name: '检测记录', exact: true })).toHaveAttribute('data-state', 'active');
  await page.screenshot({ path: out + '/audit-mobile.png', fullPage: false });
  record('MOBILE_AUDIT_SWITCHING');

  const readonly = await authenticatedApi(out, 'readonly');
  try { assert.equal((await readonly.api.post('/api/policy-bundles', { headers: readonly.headers, data: { policyId: fixture.policyId } })).status(), 403); }
  finally { await readonly.api.dispose(); }
  record('READONLY_CANNOT_COMPILE');
  assert.deepEqual(errors, []);
  record('NO_BROWSER_RUNTIME_ERRORS');
} catch (error) {
  await page.screenshot({ path: out + '/regression-failure.png' });
  writeFileSync(out + '/regression-failure.json', JSON.stringify({ url: page.url(), body: (await page.locator('body').innerText()).slice(0,4000) }));
  checks.push({ id: 'REGRESSION', status: 'FAIL', error: error.message });
  process.exitCode = 1;
  console.error(error.message);
} finally {
  writeFileSync(out + '/policy-audit-regression.json', JSON.stringify({ status: checks.some(item => item.status === 'FAIL') ? 'FAIL' : 'PASS', scope: 'REAL_HTTP_BROWSER_SYNTHETIC_DATABASE', checks, errors }, null, 2));
  await browser.close(); await api.dispose();
}
