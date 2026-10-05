import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

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
    trace: 'retain-on-failure',
  },
  // Chromium always; BROWSERS=all adds Firefox and WebKit (the CI matrix runs those; the sandbox has Chromium only)
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1000 },
        launchOptions: chromium ? { executablePath: chromium } : {},
      },
    },
    ...(process.env.BROWSERS === 'all'
      ? [
          {
            name: 'firefox',
            use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 1000 } },
          },
          { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 1000 } } },
        ]
      : []),
  ],
  webServer: [
    {
      command: 'pnpm --filter @dienst/api start',
      url: 'http://localhost:3000/api/v1/health',
      reuseExistingServer: true,
      timeout: 60_000,
      cwd: '..',
      // many logins from one IP in a minute: raise the production limits for the test server
      env: {
        RATE_LIMIT_AUTH: '1000',
        RATE_LIMIT_KIOSK: '1000',
        RATE_LIMIT_GLOBAL: '100000',
        DATABASE_URL: process.env.DATABASE_URL || 'postgres://dienst:dienst@localhost:5432/dienst_test',
      },
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
