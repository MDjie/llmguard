import { expect, test, type Page } from '@playwright/test';

// Browser-only fixtures. No authentication changes or writes to a real database.
const permissions = ['guard:use', 'history:read', 'policy:read', 'policy:manage', 'provider:manage', 'security:operate', 'audit:read', 'audit:export'];
const policyFixture = [
  { id: 'ui-policy-1', name: '通用提示词注入防护', description: '识别直接注入与越狱攻击，保护正常业务对话。', isDefault: true, isActive: true, version: 3, tags: ['通用防护'], rules: [{ id: 'r1', dimension: 'prompt_injection', enabled: true }], stats: { totalRules: 12, totalDimensions: 5, configuredDimensions: 1, totalKeywords: 124, totalCategories: 8 }, createdAt: '2026-09-01T00:00:00Z', updatedAt: null },
  { id: 'ui-policy-2', name: '敏感信息防泄露', description: '识别业务敏感数据并执行脱敏处置。', isDefault: false, isActive: true, version: 2, tags: ['数据保护'], rules: [{ id: 'r2', dimension: 'pii_leak', enabled: true }], stats: { totalRules: 8, totalDimensions: 5, configuredDimensions: 1, totalKeywords: 68, totalCategories: 4 }, createdAt: '2026-09-01T00:00:00Z', updatedAt: null },
  { id: 'ui-policy-3', name: '研发助手安全策略', description: '研发场景的代码与内容安全检查。', isDefault: false, isActive: false, version: 1, tags: ['研发'], rules: [{ id: 'r3', dimension: 'malicious_code', enabled: true }], stats: { totalRules: 5, totalDimensions: 5, configuredDimensions: 1, totalKeywords: 32, totalCategories: 3 }, createdAt: '2026-09-01T00:00:00Z', updatedAt: null },
];
const sessionFixture = Array.from({ length: 8 }, (_, i) => ({
  id: `ui-session-${i}`, inputText: i === 0 ? null : `用于界面回归的检测文本 ${i + 1}`,
  outputText: null, action: ['mask', 'block', 'warn', 'allow', 'rewrite', 'unknown_action', 'block', 'mask'][i],
  inputAction: ['mask', 'block', 'warn', 'allow', 'rewrite', 'unknown_action', 'block', 'mask'][i], outputAction: null,
  inputScore: 20 + i * 8, outputScore: i === 1 ? 95 : null, contentStored: false, policyName: policyFixture[i % 3].name,
  direction: 'input', providerName: '测试模型', modelUsed: 'ui-fixture-model', latencyMs: 28 + i,
  hasRisk: i !== 3, riskLevel: 'medium', createdAt: `2026-09-07T02:${String(30 - i).padStart(2, '0')}:00Z`,
  findings: [{ dimension: i % 2 ? 'prompt_injection' : 'pii_leak', dimensionName: i % 2 ? '提示词注入' : '信息泄露', score: 30 + i, severity: 'medium', matchedRules: ['测试规则'], evidence: ['已脱敏的测试证据'], reason: '界面回归样本' }],
}));
const incidentFixture = Array.from({ length: 6 }, (_, i) => ({
  id: `ui-incident-${i}`, incidentNumber: `EVT-UI-${String(i + 1).padStart(4, '0')}`, title: ['提示词注入风险', '敏感内容外发风险', '异常工具参数', '内容合规风险', '系统提示词泄露风险', '需要复核的对话'][i],
  severity: ['CRITICAL', 'HIGH', 'MEDIUM', 'HIGH', 'LOW', 'MEDIUM'][i], status: ['PENDING_REVIEW', 'IN_PROGRESS', 'BLOCKED', 'REMEDIATED', 'CLOSED', 'PENDING_REVIEW'][i],
  traceId: `trace-ui-${i}`, sessionId: `ui-session-${i}`, riskType: i % 2 ? '敏感信息泄露' : '提示词注入',
  eventAnalysis: '该内容用于界面回归验证，不含实际业务数据。', attackTechnique: '检测到可疑指令覆盖意图', impact: '测试应用内的一次模型调用', answerEvidence: '已脱敏的风险证据摘要',
  assigneeId: i % 2 ? '安全运营' : null, slaDueAt: '2026-12-31T00:00:00Z', resolution: null, version: 1,
  createdBy: 'ui-user', createdAt: '2026-09-07T02:30:00Z', updatedAt: '2026-09-07T02:30:00Z', closedAt: null, slaBreached: false, transitions: [],
}));

async function mockConsole(page: Page, allowed = permissions) {
  const policies = structuredClone(policyFixture);
  const writes: string[] = [];
  let statsFailures = 0;
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') writes.push(`${request.method()} ${url.pathname}`);
    const fulfill = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (url.pathname === '/api/auth/me') return fulfill({ success: true, user: { id: 'ui-user', username: 'ui-review', nickname: '界面验证', role: 'admin', permissions: allowed, tenantId: 'ui-tenant', applicationId: 'ui-app' } });
    if (url.pathname === '/api/applications') return fulfill({ items: [{ id: 'ui-app', tenantId: 'ui-tenant', code: 'ui', name: '界面回归测试应用', status: 'active' }] });
    if (url.pathname === '/api/health/db') return fulfill({ status: 'ready' });
    if (url.pathname === '/api/stats') {
      if (statsFailures-- > 0) return fulfill({ success: false, error: '测试统计加载失败' }, 503);
      return fulfill({ success: true, data: { totalDetections: 12856, todayDetections: 1528, actionDistribution: { allow: 9870, block: 1204, warn: 596, mask: 987, rewrite: 199 }, riskDistribution: { prompt_injection: 1106, pii_leak: 696, malicious_code: 518, violence_hate: 341, illegal_content: 204 }, avgScore: 26.5, avgLatency: 48, blockRate: '9.37%', trend: Array.from({ length: 7 }, (_, i) => ({ date: `2026-09-0${i + 1}`, count: [1240, 1640, 1510, 2190, 1870, 2320, 1528][i], blockCount: [180, 240, 170, 350, 260, 310, 220][i], warnCount: 60 + i * 20, maskCount: 100 + i * 12 })) } });
    }
    if (url.pathname === '/api/policies') return fulfill({ success: true, data: policies });
    if (url.pathname.endsWith('/toggle')) {
      const policy = policies.find((item) => url.pathname.includes(item.id));
      if (policy) policy.isActive = !policy.isActive;
      return fulfill({ success: true, message: '策略状态已更新' });
    }
    if (url.pathname === '/api/dimensions') return fulfill({ success: true, data: [{ id: 'd1', code: 'prompt_injection', name: '提示词注入防护' }, { id: 'd2', code: 'pii_leak', name: '敏感信息防泄露' }, { id: 'd3', code: 'malicious_code', name: '代码安全' }] });
    if (url.pathname === '/api/history') {
      const action = url.searchParams.get('action');
      const search = url.searchParams.get('search');
      const rows = sessionFixture.filter((item) => (!action || item.action === action) && (!search || item.inputText?.includes(search)));
      return fulfill({ success: true, data: { sessions: rows, pagination: { page: 1, limit: 20, total: rows.length, totalPages: 1 } } });
    }
    if (url.pathname === '/api/incidents') return fulfill({ items: incidentFixture.filter((item) => (!url.searchParams.get('status') || item.status === url.searchParams.get('status')) && (!url.searchParams.get('severity') || item.severity === url.searchParams.get('severity'))), total: 6 });
    if (url.pathname.startsWith('/api/incidents/ui-incident-')) return fulfill(incidentFixture.find((item) => url.pathname.endsWith(item.id)));
    return fulfill({ error: `Unexpected UI test request ${url.pathname}` }, 501);
  });
  return { writes, pageErrors, failStats: () => { statsFailures = 1; } };
}

async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
}

test.describe('whitepaper console UI', () => {
  test.setTimeout(120_000);
  test.beforeEach(async ({ page, isMobile }) => {
    if (!isMobile) await page.setViewportSize({ width: 1440, height: 1000 });
  });

  test('renders charts and recovers from a failed refresh without presenting zero values', async ({ page }, testInfo) => {
    const mock = await mockConsole(page);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: '总览大屏' })).toBeVisible();
    await expect(page.getByText('12,856', { exact: true })).toBeVisible();
    await expect(page.getByText('9.37%', { exact: true })).toBeVisible();
    await expect(page.getByRole('table').getByRole('row').nth(1).getByRole('cell').nth(3)).toHaveText('95');
    await expect(page.locator('.console-shell')).toHaveCSS('background-color', 'rgb(245, 247, 252)');
    await expect(page.getByRole('button', { name: '用户菜单' }).locator('span').first()).toHaveCSS('background-color', 'rgb(8, 98, 255)');
    await expect(page.getByLabel('当前应用')).toBeVisible();
    await expect(page.getByRole('table').locator('thead')).toHaveCSS('background-color', 'rgb(241, 245, 253)');
    await noPageOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: !testInfo.project.name.startsWith('mobile'), animations: 'disabled' });
    mock.failStats();
    await page.getByRole('button', { name: '刷新数据' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('测试统计加载失败');
    await expect(page.getByText('12,856', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '刷新数据' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
    expect(mock.pageErrors).toEqual([]);
    expect(mock.writes).toEqual([]);
  });

  test('filters policy data and preserves configuration, clone and toggle actions', async ({ page }, testInfo) => {
    const mock = await mockConsole(page);
    await page.goto('/policies');
    await expect(page.getByRole('heading', { name: '安全策略', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '敏感信息防泄露', exact: true }).click();
    await expect(page.getByRole('heading', { name: '敏感信息防泄露', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('policies.png'), fullPage: !testInfo.project.name.startsWith('mobile'), animations: 'disabled' });
    await page.getByLabel('搜索策略').fill('研发');
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);
    await page.getByRole('switch', { name: '研发助手安全策略启用状态' }).click();
    await expect(page.getByRole('switch', { name: '研发助手安全策略启用状态' })).toBeChecked();
    await page.getByRole('button', { name: '研发助手安全策略更多操作' }).click();
    await page.getByRole('menuitem', { name: '克隆策略' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('link', { name: '打开详细配置' })).toHaveAttribute('href', '/policies/ui-policy-3');
    await noPageOverflow(page);
    expect(mock.writes).toEqual(['PUT /api/policies/ui-policy-3/toggle']);
    expect(mock.pageErrors).toEqual([]);
  });

  test('shows incident evidence and audit actions in a responsive inspector', async ({ page, isMobile }, testInfo) => {
    const mock = await mockConsole(page);
    await page.goto('/incidents');
    await expect(page.getByRole('heading', { name: '风险事件', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '查看事件详情' }).first().click();
    await expect(page.getByRole('heading', { name: '提示词注入风险', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '提交处置' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('incidents.png'), fullPage: !testInfo.project.name.startsWith('mobile'), animations: 'disabled' });
    if (isMobile) await page.keyboard.press('Escape');
    else await page.getByRole('button', { name: '关闭事件详情' }).click();
    await page.goto('/history');
    await expect(page.getByRole('heading', { name: '内容审计', exact: true })).toBeVisible();
    const firstRow = page.getByRole('table').getByRole('row').nth(1);
    await expect(firstRow).toContainText('脱敏');
    await expect(firstRow).not.toContainText('放行');
    await expect(page.getByRole('table')).toContainText('unknown_action');
    await expect(page.getByRole('table').getByRole('row').nth(2).getByRole('cell').nth(4)).toHaveText('95');
    await firstRow.getByRole('button', { name: '详情' }).click();
    await expect(page.getByText('查看记录详情与相关操作')).toHaveCount(isMobile ? 1 : 0);
    await page.screenshot({ path: testInfo.outputPath('history.png'), fullPage: !testInfo.project.name.startsWith('mobile'), animations: 'disabled' });
    await noPageOverflow(page);
    expect(mock.writes).toEqual([]);
    expect(mock.pageErrors).toEqual([]);
  });

  test('keeps permission filtering and keyboard navigation after the shell redesign', async ({ page, isMobile }) => {
    await mockConsole(page, ['history:read']);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: '总览大屏' })).toBeVisible();
    if (isMobile) await page.getByRole('button', { name: '打开导航' }).click();
    const nav = page.getByRole('navigation', { name: '主导航' }).filter({ visible: true });
    await expect(nav.getByRole('link', { name: '安全策略' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: '总览大屏' })).toHaveAttribute('aria-current', 'page');
    await nav.getByRole('link', { name: '内容审计' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: '内容审计', exact: true })).toBeVisible();
    if (isMobile) await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: '用户菜单' }).click();
    await expect(page.getByRole('menuitem', { name: '信息修改' })).toBeVisible();
    await page.keyboard.press('Escape');
    await noPageOverflow(page);
  });
});
