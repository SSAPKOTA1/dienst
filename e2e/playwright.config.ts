import { defineConfig } from '@playwright/test';

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
    launchOptions: { executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' },
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
      env: { RATE_LIMIT_AUTH: '1000', RATE_LIMIT_KIOSK: '1000' },
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
