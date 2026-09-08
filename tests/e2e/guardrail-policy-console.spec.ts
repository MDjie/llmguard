import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const username = process.env.E2E_USERNAME;
const password = process.env.E2E_PASSWORD;
const policyId = process.env.E2E_POLICY_ID ?? 'default-policy-strict';

test.describe('guardrail policy console read-only consistency', () => {
  test('keeps the protected keyword page and paged API consistent', async ({ page }) => {
    test.skip(!username || !password, 'Set isolated E2E credentials to run the authenticated console check.');
    if (!username || !password) return;
    const savedState = process.env.E2E_POLICY_STORAGE_STATE;
    if (savedState) {
      const state = JSON.parse(readFileSync(savedState, 'utf8')) as { cookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>> };
      await page.context().addCookies(state.cookies);
      expect((await page.request.get('/api/auth/me')).status()).toBe(200);
    } else {
    await page.goto('/login');
    await page.getByPlaceholder('请输入用户名').fill(username);
    await page.getByPlaceholder('请输入密码').fill(password);
    await page.getByPlaceholder('请输入验证码').fill((await page.locator('.captcha').innerText()).trim());
    await page.getByRole('button', { name: '登 录' }).click();
    await expect(page).not.toHaveURL(/\/login$/u);

    }
    const response = await page.request.get(`/api/policies/${policyId}/keywords?dimension=prompt_injection&page=1&pageSize=20`);
    expect(response.status()).toBe(200);
    const payload = await response.json() as { success: boolean; data: { items: Array<{ keyword: string; dimension: string }>; total: number; page: number; pageSize: number; totalPages: number } };
    expect(payload.success).toBe(true);
    expect(payload.data.items.length).toBeLessThanOrEqual(20);
    expect(payload.data.totalPages).toBe(Math.ceil(payload.data.total / payload.data.pageSize));
    expect(payload.data.items.every((item) => item.dimension === 'prompt_injection')).toBe(true);

    await page.goto(`/policies/${policyId}`);
    await page.getByRole('tab', { name: '关键词管理' }).click();
    await expect(page.getByText('提示词注入 · 中英文覆盖目录', { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('搜索关键词...')).toBeVisible();
  });
});
