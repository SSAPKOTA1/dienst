import { expect, test } from '@playwright/test';
import { login } from './helpers';

test.describe('Stunden und Regeln', () => {
  test('admin edits the working-time limits (stricter only), hour categories, feature toggles and downloads the payroll export', async ({ page }) => {
    await login(page, 'admin@demo.test', { totp: true, role: /Administration/ });
    await page.goto('/admin/rules');
    const max = page.getByTestId('lim-dailyMaxMinutes');
    await expect(max).toHaveValue('600');
    await max.fill('700');
    await page.getByTestId('lim-save').click();
    await expect(page.getByRole('alert')).toContainText('dailyMaxMinutes');
    await max.fill('540');
    await page.getByTestId('lim-dailyWarnMinutes').fill('480');
    await page.getByTestId('lim-save').click();
    await expect(page.getByText('Angepasst')).toBeVisible();
    await page.getByRole('button', { name: 'Auf Standard zurücksetzen' }).click();
    await expect(page.getByText('Gesetzliche Standardwerte')).toBeVisible();
    await expect(max).toHaveValue('600');

    // categories: system rows are fixed, own rows can be added and removed
    await expect(page.getByTestId('cat-row').filter({ hasText: 'Sonntagsarbeit' })).toContainText('Standard');
    await page.getByTestId('cat-new').click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Code (a-z, 0-9, _)').fill('saturday');
    await d.getByLabel('Name').fill('Samstagsarbeit');
    await d.getByLabel('Wochentag (1 = Montag … 7 = Sonntag)').fill('6');
    await d.getByRole('button', { name: 'Speichern' }).click();
    const row = page.getByTestId('cat-row').filter({ hasText: 'Samstagsarbeit' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Löschen' }).click();
    await expect(row).toHaveCount(0);

    // feature toggle
    const sw = page.getByTestId('feature-row').filter({ hasText: 'Wünsche' }).getByRole('switch');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');

    // payroll preview export
    await page.goto('/admin/overview');
    await page.getByLabel('Auch offenen Monat (Vorschau)').check();
    const [csv] = await Promise.all([page.waitForEvent('download'), page.getByTestId('payroll-csv').click()]);
    expect(csv.suggestedFilename()).toMatch(/^lohnexport_\d{4}-\d{2}\.csv$/);
  });

  test('planner views: compliance reports, analytics and the time-account ledger of an employee', async ({ page }) => {
    await login(page, 'manager@demo.test');
    await page.goto('/compliance');
    await expect(page.getByTestId('compliance-rest')).toBeVisible();
    await page.getByRole('button', { name: 'Ersatzruhetage' }).click();
    await expect(page.getByTestId('compliance-replacement')).toBeVisible();
    await page.getByRole('button', { name: 'Sonntage und Nächte' }).click();
    await expect(page.getByTestId('compliance-sundays').locator('tbody tr').first()).toBeVisible();

    await page.goto('/analytics');
    await expect(page.getByTestId('an-pending')).toContainText(/\d/);
    await expect(page.getByTestId('an-table').locator('tbody tr').first()).toBeVisible();
    await expect(page.getByText('Es gibt keine Rangliste')).toBeVisible();

    await page.goto('/staff');
    await page.getByText(/^Maria G/).first().click();
    await expect(page.getByTestId('ledger-balance')).toContainText('h');
    await expect(page.getByTestId('ledger-line').first()).toBeVisible();
  });
});
