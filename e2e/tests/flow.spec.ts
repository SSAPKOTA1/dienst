import { expect, test } from '@playwright/test';
import { addDays, drag, isoDate, KIOSK_TOKEN, login, mondayOf } from './helpers';

// SPEC section 8: login -> plan a week by drag and drop -> publish -> kiosk punch with PIN -> approve -> timesheet PDF
const week = isoDate(addDays(mondayOf(), 21));

test('plan by drag and drop, publish, punch at the tablet, approve, download the timesheet', async ({ browser, page }) => {
  test.setTimeout(150_000);
  // 1. tablet: Aylin has no plan for today, so the punch is unplanned and needs a decision
  const kctx = await browser.newContext({ baseURL: 'http://localhost:5173', locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const tablet = await kctx.newPage();
  await tablet.addInitScript((t) => localStorage.setItem('kioskToken', t), KIOSK_TOKEN);
  await tablet.goto('/kiosk');
  const pin = async (v: string) => {
    for (const d of v) await tablet.getByTestId(`key-${d}`).click();
  };
  const punch = async () => {
    await tablet.getByTestId('kiosk-search').fill('Aylin');
    await tablet.getByTestId('kiosk-found').getByRole('button', { name: /Aylin/ }).click();
    await pin('159357');
  };
  await punch();
  await expect(tablet.getByTestId('kiosk-done')).toContainText('Eingestempelt');
  const clockedInAt = Date.now();
  await tablet.getByTestId('kiosk-finish').click();

  // 2. plan + publish a week by drag and drop while the shift runs
  await login(page, 'manager@demo.test');
  await page.goto(`/planning?week=${week}`);
  await expect(page.getByRole('grid')).toBeVisible();
  const aylin = page.locator('[role=row]', { hasText: 'Aylin' });
  await drag(page, page.getByTestId('pal-1'), aylin.locator('[role=gridcell]').nth(1));
  await expect(aylin.locator('[role=gridcell]').nth(1).locator('.pl-chip')).toHaveCount(1);
  await page.getByTestId('publish').click();
  await expect(page.getByTestId('count-drafts')).toHaveText('0');

  // 3. clock out (a second punch within 60 s counts as the same clock-in, SPEC 4.5)
  await page.waitForTimeout(Math.max(0, 62_000 - (Date.now() - clockedInAt)));
  await punch();
  await expect(tablet.getByRole('heading', { name: /Pause bestätigen/ })).toBeVisible();
  await tablet.getByTestId('break-ok').click();
  await expect(tablet.getByTestId('kiosk-done')).toContainText('Ausgestempelt');
  await kctx.close();

  // 4. approve in the inbox
  await page.goto('/requests');
  const row = page.getByTestId('worked-row').filter({ hasText: 'Aylin' });
  await expect(row).toContainText('Ungeplant');
  await row.getByRole('button', { name: 'Freigeben' }).click();
  await expect(row).toHaveCount(0);

  // 5. timesheet PDF
  await page.goto('/staff');
  await page.getByText(/^Aylin/).first().click();
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByTestId('timesheet-pdf').click()]);
  expect(pdf.suggestedFilename()).toMatch(/^stundenzettel_Aylin.*\.pdf$/);
});
