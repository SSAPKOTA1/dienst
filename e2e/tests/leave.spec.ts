import { expect, test } from '@playwright/test';
import { login } from './helpers';

const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const monday = (plus: number) => {
  const d = new Date();
  d.setDate(d.getDate() + plus);
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7));
  return d;
};

test.describe('Urlaub', () => {
  test('planner view: year table, half-day entry, blackout periods, month overview', async ({ page }) => {
    await login(page, 'manager@demo.test');
    await page.goto('/vacation');
    await expect(page.getByTestId('vac-row').first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Anspruch' })).toBeVisible();
    await page.getByRole('button', { name: 'Jahresübersicht' }).click();
    await expect(page.getByRole('columnheader', { name: 'Mär' })).toBeVisible();

    // half-day vacation for Maria
    await page.getByTestId('vac-entry').click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Mitarbeiter').selectOption({ label: 'Maria G.' });
    const day = iso(monday(150));
    await dlg.getByLabel('Von').fill(day);
    await dlg.getByLabel('Halber Tag').selectOption('morning');
    await dlg.getByRole('button', { name: 'Speichern' }).click();
    await expect(dlg).toBeHidden();

    // blackout: create and delete
    await page.goto('/vacation/blackouts');
    await page.getByTestId('blackout-new').click();
    const b = page.getByRole('dialog');
    await b.getByLabel('Von').fill(iso(monday(300)));
    await b.getByLabel('Bis').fill(iso(monday(305)));
    await b.getByLabel('Grund').fill('Messe');
    await b.getByRole('button', { name: 'Speichern' }).click();
    const row = page.getByTestId('blackout-row').filter({ hasText: 'Messe' });
    await expect(row).toContainText('Kein Urlaub');
    await row.getByRole('button', { name: 'Löschen' }).click();
    await expect(row).toHaveCount(0);

    await page.goto('/month');
    await expect(page.getByTestId('month-table').locator('tbody tr').first()).toBeVisible();
    await page.getByRole('button', { name: 'Nächster Monat' }).click();
    await expect(page.getByTestId('month-table')).toBeVisible();
  });

  test('wishes: employee sends a leave wish, the manager grants it, the employee sees the decision', async ({ browser }) => {
    const ectx = await browser.newContext({ baseURL: 'http://localhost:5173', viewport: { width: 390, height: 844 }, locale: 'de-DE' });
    const emp = await ectx.newPage();
    await login(emp, 'maria.garcia');
    await emp.goto('/me/vacation');
    await emp.getByTestId('wish-leave-new').click();
    const from = iso(monday(200));
    await emp.getByLabel('Von').fill(from);
    await emp.getByLabel('Bis').fill(from);
    await emp.getByLabel('Anmerkung (optional)').fill('Familienfeier');
    await emp.getByRole('button', { name: 'Wunsch senden' }).click();
    await expect(emp.getByTestId('wish-row').filter({ hasText: 'offen' }).first()).toBeVisible();

    const mctx = await browser.newContext({ baseURL: 'http://localhost:5173', locale: 'de-DE', viewport: { width: 1440, height: 1000 } });
    const mgr = await mctx.newPage();
    await login(mgr, 'manager@demo.test');
    await mgr.goto('/vacation/wishes');
    const row = mgr.getByTestId('wish-row').filter({ hasText: 'Maria G.' }).first();
    await expect(row).toContainText('Familienfeier');
    await row.getByRole('button', { name: 'Erfüllen' }).click();
    await expect(row).toHaveCount(0);
    await mctx.close();

    await emp.reload();
    await expect(emp.getByTestId('wish-row').filter({ hasText: 'erfüllt' }).first()).toBeVisible();
    await ectx.close();
  });
});
