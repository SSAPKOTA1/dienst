import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// the sandbox ships its own Chromium; CI and laptops use the one `playwright install` downloads
const chromium =
  process.env.CHROMIUM_PATH ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

export default defineConfig({
  testDir: './tests',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  use: {
    baseURL: 'http://localhost:5173',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    launchOptions: chromium ? { executablePath: chromium } : {},
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @dienst/api start',
      url: 'http://localhost:3000/api/v1/health',
      reuseExistingServer: true,
      timeout: 60_000,
      cwd: '..',
      // many logins from one IP in a minute: raise the production limits for the test server
      env: { RATE_LIMIT_AUTH: '1000', RATE_LIMIT_KIOSK: '1000', RATE_LIMIT_GLOBAL: '100000' },
    },
    {
      command: 'pnpm --filter @dienst/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
      cwd: '..',
    },
  ],
});
