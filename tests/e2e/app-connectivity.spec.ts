import { expect, test } from '@playwright/test';

const authenticatedUsername = process.env.E2E_USERNAME;
const authenticatedPassword = process.env.E2E_PASSWORD;

test.describe('frontend and backend connectivity', () => {
  test('serves operational endpoints and a defined database readiness state', async ({ request }) => {
    const live = await request.get('/api/health/live');
    expect(live.status()).toBe(200);
    await expect(live.json()).resolves.toMatchObject({
      status: 'ok',
      service: 'guardllm',
    });

    const readiness = await request.get('/api/health/db');
    expect([200, 503]).toContain(readiness.status());
    const readinessBody = await readiness.json() as {
      status?: string;
      code?: string;
    };
    if (readiness.status() === 200) {
      expect(readinessBody.status).toBe('ready');
    } else {
      expect(readinessBody.code).toBe('DATABASE_NOT_READY');
    }
  });

  test('rejects anonymous access at protected backend boundaries', async ({ request }) => {
    for (const path of ['/api/auth/me', '/api/users', '/api/policies']) {
      const response = await request.get(path);
      expect([401, 503], path).toContain(response.status());
      const expectedProblem = response.status() === 401
        ? { code: 'AUTHENTICATION_REQUIRED', status: 401 }
        : { code: 'AUDIT_UNAVAILABLE', status: 503 };
      await expect(response.json()).resolves.toMatchObject(expectedProblem);
    }
  });

  test('redirects anonymous users and connects the login form to the backend', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', {
      name: '欢迎登录国舜大模型安全护栏检测平台',
    })).toBeVisible();

    await page.getByRole('button', { name: '登 录' }).click();
    await expect(page.getByText('请输入用户名')).toBeVisible();

    const username = page.getByPlaceholder('请输入用户名');
    const password = page.getByPlaceholder('请输入密码');
    await username.fill('e2e-user-that-does-not-exist');
    await password.fill('NotARealPassword!234');
    await expect(password).toHaveAttribute('type', 'password');
    await page.locator('button.eye-toggle').click();
    await expect(password).toHaveAttribute('type', 'text');

    const captchaCode = (await page.locator('.captcha').innerText()).trim();
    expect(captchaCode).toMatch(/^[A-Z2-9]{4}$/);
    await page.getByPlaceholder('请输入验证码').fill(captchaCode);

    const loginResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith('/api/auth/login') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '登 录' }).click();
    const loginResponse = await loginResponsePromise;
    expect([401, 500, 503]).toContain(loginResponse.status());
    await expect(page.getByText(
      loginResponse.status() === 401
        ? '用户名、密码或账户状态无效。'
        : '认证服务暂不可用，请稍后重试',
    )).toBeVisible();
  });

  test('opens and closes user-support dialogs', async ({ page }) => {
    await page.goto('/login');

    await page.getByRole('button', { name: '联系客服' }).click();
    await expect(page.getByRole('dialog')).toContainText('400-696-8096');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.getByRole('button', { name: '帮助中心' }).click();
    await expect(page.getByRole('dialog')).toContainText('无法登录怎么办？');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('completes an authenticated navigation and logout workflow', async ({ page }) => {
    test.skip(
      !authenticatedUsername || !authenticatedPassword,
      'Set E2E_USERNAME and E2E_PASSWORD to run the authenticated workflow.',
    );
    if (!authenticatedUsername || !authenticatedPassword) return;

    await page.goto('/login');
    await page.getByPlaceholder('请输入用户名').fill(authenticatedUsername);
    await page.getByPlaceholder('请输入密码').fill(authenticatedPassword);
    const captchaCode = (await page.locator('.captcha').innerText()).trim();
    await page.getByPlaceholder('请输入验证码').fill(captchaCode);

    const loginResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith('/api/auth/login') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '登 录' }).click();
    expect((await loginResponsePromise).status()).toBe(200);

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: '大模型安全护栏检测平台' })).toBeVisible();

    const currentUser = await page.request.get('/api/auth/me');
    expect(currentUser.status()).toBe(200);
    await expect(currentUser.json()).resolves.toMatchObject({
      success: true,
      user: { username: authenticatedUsername },
    });

    await page.getByRole('link', { name: /模型管理/ }).click();
    await expect(page).toHaveURL(/\/providers$/);
    await expect(page.getByRole('heading', { name: '模型供应商管理' })).toBeVisible();

    await page.getByRole('button', { name: /系统管理员|e2e-admin/ }).click();
    const logoutResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith('/api/auth/logout') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '退出登录' }).click();
    const logoutResponse = await logoutResponsePromise;
    const logoutPayload = await logoutResponse.json().catch(() => null) as unknown;
    expect(logoutResponse.status(), JSON.stringify(logoutPayload)).toBe(200);
    await expect(page).toHaveURL(/\/login$/);
    expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  });
});
