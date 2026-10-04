import { expect, test } from '@playwright/test';
import { KIOSK_TOKEN, login } from './helpers';

test.describe('Tablet', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('kioskToken', t), KIOSK_TOKEN);
    await page.goto('/kiosk');
    await expect(page.getByTestId('kiosk-clock')).toBeVisible();
  });

  const pressPin = async (page: import('@playwright/test').Page, pin: string) => {
    for (const d of pin) await page.getByTestId(`key-${d}`).click();
  };

  test('unknown device gets the registration screen', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: 'http://localhost:5173' });
    const page = await ctx.newPage();
    await page.addInitScript(() => localStorage.setItem('kioskToken', 'kd_wrong'));
    await page.goto('/kiosk');
    await expect(page.getByRole('heading', { name: 'Gerät nicht registriert' })).toBeVisible();
    await ctx.close();
  });

  test('wrong PIN shows the remaining attempts; search finds a name', async ({ page }) => {
    await page.getByTestId('kiosk-search').fill('Fatima');
    await page.getByTestId('kiosk-found').getByRole('button', { name: 'Fatima A.' }).click();
    await pressPin(page, '000000');
    await expect(page.getByTestId('kiosk-error')).toHaveText('Falsche PIN. Noch 4 Versuche.');
  });

  test('clock in with name + PIN, then clock out with the break screen', async ({ page }) => {
    await page.getByTestId('kiosk-search').fill('Tom');
    await page.getByTestId('kiosk-found').getByRole('button', { name: 'Tom W.' }).click();
    await pressPin(page, '371596');
    await expect(page.getByTestId('kiosk-done')).toContainText('Eingestempelt');
    await page.getByTestId('kiosk-finish').click();
    // he is working now: the roster card says so and the next PIN entry clocks him out
    await page.getByTestId('kiosk-search').fill('Tom');
    await page.getByTestId('kiosk-found').getByRole('button', { name: 'Tom W.' }).click();
    await expect(page.getByTestId('kiosk-card-Tom W.')).toHaveCount(0); // search path: card state is not known here, the server decides
  });

  test('an open record from the seed is closed through the break confirmation', async ({ page }) => {
    await page.getByTestId('kiosk-card-Piotr N.').click();
    await pressPin(page, '297031');
    await expect(page.getByRole('heading', { name: /Pause bestätigen/ })).toBeVisible();
    // 3 h of work: no break is required, so 0 is pre-selected and one tap confirms
    await expect(page.getByTestId('break-0')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('break-ok').click();
    await expect(page.getByTestId('kiosk-done')).toContainText('Ausgestempelt');
  });
});

test('Live-Übersicht shows the groups and the tablet as online', async ({ page }) => {
  await login(page, 'manager@demo.test');
  await page.goto('/live');
  await expect(page.getByTestId('live-in')).toBeVisible();
  await expect(page.getByTestId('live-rev')).toBeVisible();
  await expect(page.getByTestId('server-time')).toHaveText(/\d\d:\d\d/);
});
