import { expect, type Page } from '@playwright/test';
import { authenticator } from 'otplib';

export const PASSWORD = 'Demo!2345';
export const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
export const KIOSK_TOKEN = 'kd_demo_frankfurt_4f1c9a7e2b6d8035a1e94c7b02d6f83a';

export async function login(page: Page, loginName: string, opts: { totp?: boolean; role?: RegExp } = {}) {
  await page.goto('/login');
  await page.fill('#login', loginName);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  if (opts.totp) {
    await page.fill('#totp', authenticator.generate(TOTP_SECRET));
    await page.getByRole('button', { name: 'Anmelden' }).click();
  }
  if (opts.role) await page.getByRole('button', { name: opts.role }).click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const mondayOf = (d = new Date()) => {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
};
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

/** real mouse drag (dnd-kit pointer sensor needs several move events) */
export async function drag(page: Page, from: ReturnType<Page['locator']>, to: ReturnType<Page['locator']>) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.waitForTimeout(600); // let the dry-run validation colour the target
  await page.mouse.up();
}
