import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import base from './playwright.config';
const directory = process.env.COMPREHENSIVE_RUN_DIR;
if (!directory) throw new Error('COMPREHENSIVE_RUN_DIR_REQUIRED');
const fixture: { baseURL: string; dataset: string; username: string; password: string; policyId: string; logoutDesktop: {username:string;password:string}; logoutMobile: {username:string;password:string} } = JSON.parse(readFileSync(resolve(directory, 'fixture.private.json'), 'utf8'));
if (fixture.dataset !== 'SYNTHETIC_ONLY_NEW_EMPTY_DATABASE' || fixture.baseURL !== 'http://127.0.0.1:58089') throw new Error('ISOLATED_FIXTURE_REQUIRED');
process.env.E2E_DESKTOP_USERNAME = fixture.logoutDesktop.username;process.env.E2E_DESKTOP_PASSWORD = fixture.logoutDesktop.password;
process.env.E2E_MOBILE_USERNAME = fixture.logoutMobile.username;process.env.E2E_MOBILE_PASSWORD = fixture.logoutMobile.password;
process.env.E2E_POLICY_ID = fixture.policyId;
process.env.E2E_POLICY_STORAGE_STATE = resolve(directory, 'browser-state.private.json');
export default defineConfig({
  ...base,
  testDir: './tests/e2e',
  outputDir: resolve(directory, 'playwright-private-artifacts'),
  retries: 0,
  webServer: undefined,
  use: { ...base.use, baseURL: fixture.baseURL },
  reporter: [['list'], ['json', { outputFile: resolve(directory, 'playwright-results.json') }]],
});
