import { expect, test } from '@playwright/test';
import { login } from './helpers';

test.describe('Rollen, Hotels und Mitarbeiterdaten', () => {
  test('super admin: invites a super admin, switches a hotel off and on, grants and revokes the manager role', async ({
    page,
  }) => {
    await login(page, 'sa@demo.test', { totp: true, role: /Super-Admin/ });

    // another super admin
    await page.goto('/admin/users');
    await page.getByRole('button', { name: 'Benutzer einladen' }).click();
    const invite = page.getByRole('dialog');
    await invite.getByRole('button', { name: 'Super-Admin' }).click();
    await invite.getByLabel('Vorname').fill('Sara');
    await invite.getByLabel('Nachname').fill('Zweitadmin');
    await invite.getByLabel('E-Mail').fill('sara.zweit@demo.test');
    await invite.getByRole('button', { name: 'Einladen' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByLabel('Name suchen').fill('Zweitadmin');
    await expect(page.getByRole('row', { name: /Sara Zweitadmin/ })).toContainText('Super-Admin');

    // a new hotel can be switched off and on again, its history is kept
    await page.goto('/admin/hotels');
    await page.getByRole('button', { name: 'Hotel anlegen' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('Hotel Testweg');
    await page.getByRole('dialog').getByRole('button', { name: 'Speichern' }).click();
    const hotel = page.getByRole('region', { name: 'Hotel Testweg' });
    await expect(hotel).toBeVisible();
    page.once('dialog', (d) => void d.accept());
    await hotel.getByRole('button', { name: 'Hotel deaktivieren' }).click();
    const off = page.getByRole('region', { name: 'Hotel Testweg (inaktiv)' });
    await expect(off).toContainText('inaktiv');
    await off.getByRole('button', { name: 'Hotel aktivieren' }).click();
    await expect(page.getByRole('region', { name: 'Hotel Testweg' })).toBeVisible();

    // an employee becomes a manager of one hotel, and loses the role again
    await page.goto('/admin/users');
    await page.getByLabel('Name suchen').fill('Tom');
    const row = page.getByRole('row', { name: /Tom/ });
    await row.getByRole('button', { name: /Rollen ändern/ }).click();
    const roles = page.getByRole('dialog');
    await roles.getByRole('checkbox', { name: /^Leitung/ }).check();
    await roles.getByRole('checkbox', { name: /Frankfurt/ }).first().check();
    await roles.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(row).toContainText('Leitung');
    await row.getByRole('button', { name: /Rollen ändern/ }).click();
    await page.getByRole('dialog').getByRole('checkbox', { name: /^Leitung/ }).uncheck();
    await page.getByRole('dialog').getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(row).not.toContainText('Leitung');
  });

  test('admin: edits personal data and the contract of an employee', async ({ page }) => {
    await login(page, 'admin@demo.test', { totp: true, role: /Administration/ });
    await page.goto('/staff');
    await page.getByLabel('Name suchen').fill('Sophie');
    await page.getByRole('row', { name: /Sophie/ }).first().click();

    await page.getByTestId('staff-edit').click();
    const edit = page.getByRole('dialog');
    await edit.getByLabel('Telefon').fill('0151 2345678');
    await edit.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByTestId('staff-contract').click();
    const contract = page.getByRole('dialog');
    await contract.getByLabel('Urlaubstage pro Jahr').fill('27');
    await contract.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // the change is stored: personal data in the form, the new contract version in the history
    await page.getByTestId('staff-edit').click();
    await expect(page.getByRole('dialog').getByLabel('Telefon')).toHaveValue('0151 2345678');
    await page.getByRole('dialog').getByRole('button', { name: 'Abbrechen' }).click();
    await page.getByTestId('staff-contract').click();
    await expect(page.getByTestId('contract-history')).toContainText('27 Urlaubstage');
  });
});
