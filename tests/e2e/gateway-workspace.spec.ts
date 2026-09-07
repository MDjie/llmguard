import { expect, test, type Page } from '@playwright/test';

// Synthetic UI responses only; integration tests exercise the real services separately.
const capturedAt = '2026-09-07T06:00:00Z';
const permissions = ['guard:use','history:read','application:read','application:manage','application:credential:manage','policy:read'];
async function fixture(page: Page, allowed = permissions) {
  const writes: { path: string; method: string; body: unknown }[] = [], errors: string[] = [];
  const app = { id: 'ui-app', tenantId: 'ui-tenant', code: 'ui-app', name: '企业知识助手', status: 'active', createdAt: capturedAt, owner: '安全运营', department: '信息技术部', environment: 'test', dataClass: 'internal', modelRoutes: ['test-model'], authVersion: 3, integrationState: 'CONFIGURED' };
  const request = { id: 'ui-request-001', snapshotId: 'snapshot-ui-0001', subjectId: 'ui-user', sessionId: 'ui-session', state: 'COMPLETED', stepCount: 3, lastEventSeq: 5, sessionFinalized: true, createdAt: capturedAt, expiresAt: capturedAt };
  const credential = { id: 'ui-key-1', keyId: 'key-public-id', name: '界面测试凭据', permissions: ['guard:use'], expiresAt: null, lastUsedAt: null, revokedAt: null, createdAt: capturedAt };
  let requestFailure = false, chatFailure = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url());
    const body: unknown = req.postData() ? req.postDataJSON() : undefined;
    if (req.method() !== 'GET') writes.push({ path: url.pathname, method: req.method(), body });
    const send = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (url.pathname === '/api/auth/me') return send({ success: true, user: { id: 'ui-user', username: 'ui-review', nickname: '安全运营', role: 'admin', permissions: allowed, tenantId: 'ui-tenant', applicationId: 'ui-app' } });
    if (url.pathname === '/api/chat') {
      if (req.method() === 'GET') return send({success:true,data:[{id:'ui-model',displayName:'企业模型',defaultModel:'test-model',isDefaultTarget:true}]});
      return chatFailure ? send({code:'GUARD_OUTPUT_BLOCKED',detail:'安全网关已阻断本次输出。'},403) : send({success:true,data:{provider:{id:'ui-model',name:'ui-model',displayName:'企业模型',model:'test-model'},response:'联系电话：[PHONE]',latencyMs:42,gateway:{requestId:'ui-request-001',snapshotId:'snapshot-ui-0001',inputAction:'ALLOW',outputAction:'MASK',decisionId:'recheck-allow'}}});
    }
    if (url.pathname === '/api/health/db') return send({ status: 'ready' });
    if (url.pathname === '/api/applications') {
      if (req.method() === 'PATCH') { app.authVersion++; return send({ application: app }); }
      return send({ currentApplicationId: app.id, items: [app] });
    }
    if (url.pathname === '/api/gateway/publications') return send({ items: [{ id: 'publication-ui', generation: 8, digest: 'd'.repeat(64), dispatchState: 'ANNOUNCED', loadingState: 'PARTIALLY_LOADED', loadedNodes: 1, observedRequests: 12,
      nodes: [{ nodeId: 'proxy-0', loaded: true }, { nodeId: 'proxy-1', loaded: false }], manifest: { createdAt: capturedAt, canaryPercent: 0, snapshots: { active: { snapshotId: request.snapshotId, bundleId: 'bundle-ui', digest: 'a'.repeat(64) }, previous: null, canary: null, shadow: null } } }] });
    if (url.pathname === '/api/gateway/onboarding') return send({ applicationId: app.id, applicationName: app.name, state: 'CONFIGURED', authVersion: app.authVersion, modelRoutes: app.modelRoutes, proxyConfigured: true,
      checks: [{ id: 'metadata', name: '应用资料已配置', passed: true, detail: '负责人、部门和模型路由已配置', href: '/applications' }, { id: 'actual', name: '真实调用验证', passed: false, detail: '等待当前配置完成网关调用', href: '/gateway-requests' }],
      runtime: { snapshotId: 'snapshot-ui-0001', generation: 7, bundleId: 'bundle-ui', digest: 'a'.repeat(64), state: 'LOADED', nodeCount: 2, requestCount: 0 }, sample: '{"model":"test-model","messages":[{"role":"user","content":"你好"}]}' });
    if (url.pathname === '/api/application-credentials') return req.method() === 'POST' ? send({ credential, apiKey: 'UI_ONLY_SECRET_'.repeat(4) }) : send({ items: [credential] });
    if (url.pathname === '/api/gateway/requests') {
      if (requestFailure) return send({ title: 'test unavailable' }, 503);
      if (!url.searchParams.has('id')) return send({ items: [request], totals: [{ state: 'COMPLETED', count: 1 }], timeRange: '24h', limit: 50 });
      return send({ request, resources: { state:'SETTLED', preparedInputChars:24, inspectedChars:80, inspectionSteps:3, preparedReferences:1, admissionHmac:'a'.repeat(64), settlementHmac:'b'.repeat(64), settledAt:capturedAt, modelOutcome:'SEE_EXECUTION_EVENTS' }, steps: ['INPUT','OUTPUT_COMPLETE','OUTPUT_RECHECK'].map((stage, i) => ({ id: 'step-' + i, stage, streamSeq: 0, attemptKind: i === 2 ? 'RECHECK' : 'INITIAL', decisionId: ['input-allow','original-mask','recheck-allow'][i], action: i === 1 ? 'MASK' : 'ALLOW', coverage: 'COMPLETE', status: 'SUCCEEDED', latencyMs: 12, modelVersions: [], createdAt: capturedAt })),
        events: [{ sequence: 4, kind: 'WRITE_ACCEPTED', stepId: 'step-2', decisionId: 'original-mask', recheckDecisionId: 'recheck-allow', actualAction: 'MASK', reasonCode: null, rangeStart: 0, rangeEnd: 20, payloadHmac: 'b'.repeat(64), createdAt: capturedAt }], writeAcceptedMeaning: '仅表示服务器接受写出，不代表客户端收到全部内容' });
    }
    return send({ title: 'Unexpected fixture request ' + url.pathname }, 501);
  });
  return { writes, errors, failRequests: () => { requestFailure = true; }, failChat: () => { chatFailure = true; } };
}
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy(); }

test.describe('gateway application and execution workspaces', () => {
  test.setTimeout(120_000);
  test.beforeEach(async ({ page, isMobile }) => { if (!isMobile) await page.setViewportSize({ width: 1440, height: 1000 }); });
  test('saves version-bound application settings and shows pending real verification', async ({ page, isMobile }, info) => {
    const state = await fixture(page);
    await page.goto('/applications');
    await expect(page.getByRole('heading', { name: '应用接入工作台' })).toBeVisible();
    await expect(page.getByLabel('负责人')).toHaveValue('安全运营');
    await expect(page.getByText('部分目标节点已确认',{exact:true})).toBeVisible();
    await expect(page.getByText('全部目标节点已确认',{exact:true})).toHaveCount(0);
    await expect(page.getByText('待验证', { exact: true })).toBeVisible();
    await page.getByLabel('负责人').fill('平台安全组');
    await page.getByLabel('允许调用的模型路由').fill('test-model\nbackup-model');
    await page.getByRole('button', { name: '保存配置' }).click();
    await expect.poll(() => state.writes.length).toBe(1);
    expect(state.writes[0]).toMatchObject({ path: '/api/applications', method: 'PATCH', body: { id: 'ui-app', expectedAuthVersion: 3, owner: '平台安全组', modelRoutes: ['test-model','backup-model'] } });
    await expect(page.getByText('应用配置已保存，授权版本已更新')).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('applications.png'), fullPage: !isMobile, animations: 'disabled' });
    expect(state.errors).toEqual([]);
  });
  test('shows newly issued credentials once and clears the dialog after closing', async ({ page }) => {
    const state = await fixture(page);
    await page.goto('/applications');
    await noOverflow(page);
    await page.getByRole('button', { name: '签发凭据', exact: true }).click();
    await page.getByLabel('凭据用途').fill('测试应用接入');
    await page.getByRole('dialog').getByRole('button', { name: '签发凭据', exact: true }).click();
    await expect(page.getByRole('heading', { name: '凭据已签发' })).toBeVisible();
    await expect(page.getByRole('dialog').locator('pre')).toContainText('UI_ONLY_SECRET');
    await page.keyboard.press('Escape');
    await noOverflow(page);
    await page.getByRole('button', { name: '签发凭据', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toContainText('UI_ONLY_SECRET');
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('UI_ONLY_SECRET');
    expect(state.writes).toHaveLength(1); expect(state.errors).toEqual([]);
  });
  test('keeps application controls read-only without management permissions', async ({ page }) => {
    const state = await fixture(page, ['application:read']);
    await page.goto('/applications');
    await expect(page.getByLabel('负责人')).toHaveValue('安全运营');
    await expect(page.getByLabel('负责人')).toBeDisabled();
    await expect(page.getByRole('button', { name: '保存配置' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '签发凭据' })).toHaveCount(0);
    await expect(page.getByText('当前角色无凭据管理权限。')).toBeVisible();
    await noOverflow(page); expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
  });
  test('shows original action and recheck in the write timeline and preserves data on errors', async ({ page, isMobile }, info) => {
    const state = await fixture(page);
    await page.goto('/gateway-requests');
    await page.getByRole('button', { name: 'ui-request-001', exact: true }).click();
    await expect(page.getByText('实际动作：脱敏', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading',{name:'资源结算',exact:true})).toBeVisible();
    await expect(page.getByText(/模型 Token 和费用尚未测量/)).toBeVisible();
    await expect(page.getByText('决策 original-mask', { exact: true })).toBeVisible();
    await expect(page.getByText('复检 recheck-allow', { exact: true })).toBeVisible();
    await expect(page.getByText(/仅表示服务器接受写出/)).toBeVisible();
    await page.screenshot({ path: info.outputPath('gateway-requests.png'), fullPage: !isMobile, animations: 'disabled' });
    if (isMobile) await page.keyboard.press('Escape');
    await noOverflow(page);
    state.failRequests(); await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
    await expect(page.getByRole('button', { name: 'ui-request-001', exact: true })).toBeVisible();
    expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
  });
  test('sends one gateway request and displays only the server-approved response', async ({ page, isMobile }, info) => {
    const state = await fixture(page);
    await page.goto('/');
    await expect(page.getByRole('heading', {name:'安全对话工作台'})).toBeVisible();
    await page.getByLabel('输入消息').fill('请返回业务联系人');
    await page.getByRole('button',{name:'发送消息'}).click();
    await expect(page.getByText('联系电话：[PHONE]',{exact:true})).toBeVisible();
    await expect(page.getByText('输出：脱敏',{exact:true})).toBeVisible();
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({path:'/api/chat',method:'POST',body:{providerId:'ui-model',messages:[{role:'user',content:'请返回业务联系人'}]}});
    await noOverflow(page);
    await page.screenshot({path:info.outputPath('gateway-chat.png'),fullPage:!isMobile,animations:'disabled'});
    await page.getByRole('link',{name:'查看完整执行时间线'}).click();
    await expect(page.getByText('实际动作：脱敏',{exact:true})).toBeVisible();
    expect(state.errors).toEqual([]);
  });
  test('keeps blocked content undisplayed and starts a fresh session on request', async ({page})=>{
    const state=await fixture(page);state.failChat();
    await page.goto('/');await page.getByLabel('输入消息').fill('界面拦截测试');await page.getByRole('button',{name:'发送消息'}).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('GUARD_OUTPUT_BLOCKED');
    await expect(page.getByText('模型答复',{exact:true})).toHaveCount(0);
    expect(state.writes).toHaveLength(1);
    await page.getByRole('button',{name:'新建会话'}).click();
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('界面拦截测试',{exact:true})).toHaveCount(0);
    expect(state.errors).toEqual([]);
  });

});
