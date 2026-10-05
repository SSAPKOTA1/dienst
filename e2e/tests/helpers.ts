import { expect, type Page } from '@playwright/test';
import { authenticator } from 'otplib';

export const PASSWORD = 'Demo!2345';
export const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
export const KIOSK_TOKEN = 'kd_demo_frankfurt_4f1c9a7e2b6d8035a1e94c7b02d6f83a';

let lastTotpStep = 0;
/** The server rejects a replayed TOTP code, so two admin logins need different 30 s windows. */
async function freshTotp(): Promise<string> {
  const step = () => Math.floor(Date.now() / 30000);
  while (step() === lastTotpStep) await new Promise((r) => setTimeout(r, 500));
  lastTotpStep = step();
  return authenticator.generate(TOTP_SECRET);
}

export async function login(page: Page, loginName: string, opts: { totp?: boolean; role?: RegExp } = {}) {
  await page.goto('/login');
  await page.fill('#login', loginName);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  if (opts.totp) {
    await page.fill('#totp', await freshTotp());
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
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

/** Access token for API calls from a test (users with one role get the token right away). */
export async function apiToken(request: import('@playwright/test').APIRequestContext, loginName: string, role: string, employeeId?: number) {
  const r = await request.post('http://localhost:3000/api/v1/auth/login', { data: { login: loginName, password: PASSWORD } });
  const b = await r.json();
  if (b.accessToken) return b.accessToken as string;
  const s = await request.post('http://localhost:3000/api/v1/auth/select-role', { headers: { authorization: `Bearer ${b.preToken}` }, data: { role, employeeId } });
  return (await s.json()).accessToken as string;
}
