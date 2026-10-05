import { expect, test } from '@playwright/test';
import { login } from './helpers';

test.describe('Anträge', () => {
  test('manager approves a vacation request and a time record; the inbox badge drops; admin sees it in the Protokoll', async ({ page }) => {
    await login(page, 'manager@demo.test');
    await page.goto('/requests');
    const badge = page.getByTestId('inbox-badge');
    await expect(badge).toBeVisible();
    const before = Number(await badge.textContent());

    // vacation request with remaining -> remaining after and the under-staffing hint
    const abs = page.getByTestId('absence-row').filter({ hasText: 'Fatima A.' });
    await expect(abs).toContainText('Rest 18,5 → 14,5');
    await expect(abs).toContainText('Unterbesetzung');
    await abs.getByRole('button', { name: 'Freigeben' }).click();
    await expect(abs).toHaveCount(0);

    // a flagged record cannot be ticked for the bulk action, an unflagged one can be approved directly
    const worked = page.getByTestId('worked-row');
    await expect(worked.filter({ hasText: 'Auto-Ausstempeln' }).getByRole('checkbox')).toBeDisabled();
    const n = await worked.count();
    await worked.filter({ hasText: 'Abweichung' }).getByRole('button', { name: 'Anpassen' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Freigeben' }).click();
    await expect(worked).toHaveCount(n - 1);

    await page.reload();
    await expect(page.getByTestId('inbox-badge')).toHaveText(String(before - 2));

    // admin: audit log shows both decisions, CSV export is offered
    await page.getByRole('button', { name: /Markus Lehmann/ }).click();
    await page.getByRole('menuitem', { name: /Abmelden/ }).click();
    await login(page, 'admin@demo.test', { totp: true, role: /Administration/ });
    await page.goto('/admin/audit');
    await page.getByLabel('Aktion').fill('approved');
    await expect(page.getByTestId('audit-row').first()).toContainText('approved');
    await expect(page.getByRole('button', { name: 'Als CSV exportieren' })).toBeVisible();
    // the hash chain of the company recomputes without a mismatch
    await page.getByTestId('audit-verify').click();
    await expect(page.getByTestId('audit-verify-result')).toContainText('Protokoll unverändert.');
  });

  test('Tablets and Regeln tabs render for the administration', async ({ page }) => {
    await login(page, 'admin@demo.test', { totp: true, role: /Administration/ });
    await page.goto('/admin/tablets');
    await expect(page.getByTestId('device-row').first()).toBeVisible();
    await page.goto('/admin/rules');
    await expect(page.getByRole('heading', { name: 'Regeln' })).toBeVisible();
    await expect(page.getByText('REST_PERIOD')).toBeVisible();
  });
});
