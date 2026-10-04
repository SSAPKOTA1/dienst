import { expect, test } from '@playwright/test';
import { login } from './helpers';

test.use({ viewport: { width: 390, height: 844 } });

test.describe('Handy-Portal', () => {
  test('home shows shifts, week and balances; there is no sick button', async ({ page }) => {
    await login(page, 'maria.garcia');
    await expect(page).toHaveURL(/\/me$/);
    await expect(page.getByRole('heading', { name: 'Hallo Maria' })).toBeVisible();
    await expect(page.getByTestId('next-shift').first()).toBeVisible();
    await expect(page.getByText('Resturlaub')).toBeVisible();
    await expect(page.getByText(/Krank melden|Krankmeldung/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Krank/ })).toHaveCount(0);
  });

  test('request vacation with a day preview, see it as open, withdraw it', async ({ page }) => {
    await login(page, 'maria.garcia');
    await page.goto('/me/vacation');
    await page.getByRole('button', { name: 'Urlaub beantragen' }).click();
    const d = new Date();
    d.setDate(d.getDate() + 60);
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7)); // next Monday
    const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    const end = new Date(d);
    end.setDate(end.getDate() + 2);
    await page.fill('#v-from', iso(d));
    await page.fill('#v-to', iso(end));
    await expect(page.getByTestId('vac-preview')).toContainText('3 Urlaubstage');
    await page.getByRole('dialog').getByRole('button', { name: 'Antrag senden' }).click();
    const row = page.getByTestId('vac-row').filter({ hasText: 'offen' }).first();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Zurückziehen' }).click();
    await expect(page.getByTestId('vac-row').filter({ hasText: 'zurückgezogen' }).first()).toBeVisible();
  });

  test('unapproved hours stay hidden ("Wartet auf Freigabe") and the timesheet PDF downloads', async ({ page }) => {
    await login(page, 'maria.garcia');
    await page.goto('/me/attendance');
    if ((await page.getByTestId('hours-hidden').count()) === 0) await page.getByRole('button', { name: 'Vorheriger Monat' }).click();
    await expect(page.getByTestId('hours-hidden').first()).toHaveText('Wartet auf Freigabe');
    await page.goto('/me/account');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('my-timesheet-pdf').click()]);
    expect(dl.suggestedFilename()).toMatch(/^stundenzettel_\d{4}-\d{2}\.pdf$/);
  });
});

test.describe('Exporte', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });
  test('schedule as Excel and the timesheet of an employee as PDF', async ({ page }) => {
    await login(page, 'manager@demo.test');
    await page.goto('/planning');
    await expect(page.getByTestId('export-xlsx')).toBeVisible();
    const [x] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-xlsx').click()]);
    expect(x.suggestedFilename()).toMatch(/^dienstplan_\d{4}-\d{2}-\d{2}\.xlsx$/);
    await page.goto('/staff');
    await page.getByText('Maria G.').first().click();
    const [p] = await Promise.all([page.waitForEvent('download'), page.getByTestId('timesheet-pdf').click()]);
    expect(p.suggestedFilename()).toMatch(/^stundenzettel_.*\.pdf$/);
  });
});
