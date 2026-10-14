import { expect, test } from '@playwright/test';
import { login } from './helpers';

test.describe('NFC-Tag am Hotel', () => {
  test('admin legt einen Tag an, Mitarbeiterin stempelt damit ein und aus, gesperrter Tag wird abgelehnt', async ({
    page,
    browser,
  }) => {
    // admin creates the tag for the Frankfurt hotel and sees the text to write to it
    await login(page, 'admin@demo.test', { totp: true, role: /Administration/ });
    await page.goto('/admin/tablets');
    await page.getByTestId('nfc-add').click();
    const dlg = page.getByRole('dialog');
    const hotel = (await dlg.locator('#nt-hotel option', { hasText: /Frankfurt/ }).first().textContent())!;
    await dlg.locator('#nt-hotel').selectOption({ label: hotel });
    await dlg.getByLabel('Name des Tags').fill('Personaleingang');
    await dlg.getByRole('button', { name: 'Anlegen' }).click();
    const url = (await page.getByTestId('nfc-url').textContent())!;
    expect(url).toMatch(/\/nfc\?t=nt_/);
    const token = new URL(url).searchParams.get('t')!;
    await page.getByRole('button', { name: 'Fertig' }).click();
    await expect(page.getByTestId('nfc-row')).toContainText('Personaleingang');

    // the employee taps the tag (the app opens this address); not logged in yet, so the login comes first
    const phone = await (await browser.newContext({ locale: 'de-DE' })).newPage();
    await phone.goto(`/nfc?t=${token}`); // the address on the tag
    await phone.fill('#login', 'maria.garcia');
    await phone.fill('#password', 'Demo!2345');
    await phone.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await expect(phone.getByTestId('nfc-hotel')).toContainText('Frankfurt');
    await phone.getByTestId('nfc-in').click();
    await expect(phone.getByTestId('nfc-done')).toContainText('Eingestempelt');

    // second tap: she is clocked in, so the tag offers clock-out
    await phone.goto(`/me/nfc?t=${token}`);
    await expect(phone.getByTestId('nfc-out')).toBeVisible();
    await phone.getByTestId('nfc-out').click();
    await expect(phone.getByTestId('nfc-done')).toContainText('Ausgestempelt');

    // the admin blocks the tag; it is refused afterwards
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('nfc-row').getByRole('button', { name: 'Sperren' }).click();
    await expect(page.getByTestId('nfc-row')).toContainText('Gesperrt');
    await phone.goto(`/me/nfc?t=${token}`);
    await expect(phone.getByRole('alert')).toContainText('nicht (mehr) gültig');
  });
});
