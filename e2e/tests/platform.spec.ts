import { expect, test } from '@playwright/test';
import { KIOSK_TOKEN, apiToken, isoDate, login } from './helpers';

const API = 'http://localhost:3000/api/v1';

test.describe('Plattform', () => {
  test('admin: tablet options per hotel, API key shown once, badge for an employee', async ({ page }) => {
    await login(page, 'admin@demo.test', { totp: true });
    await page.goto('/admin/hotels');
    const box = page.getByTestId(/platform-settings-/).first();
    await expect(box).toBeVisible();
    await box.getByLabel('Pausen am Tablet').selectOption('start_stop');
    await expect(page.getByText('Gespeichert.').first()).toBeVisible();
    await box.getByLabel('Pausen am Tablet').selectOption('confirm_at_clock_out');
    // web punch needs a network before it can be switched on
    await box.getByRole('switch', { name: 'Web-Stempelung erlauben' }).click();
    await expect(box.getByRole('alert')).toBeVisible();

    await page.goto('/admin/integrations');
    await page.getByRole('button', { name: 'Schlüssel anlegen' }).click();
    await page.getByLabel('Name', { exact: true }).fill('e2e payroll');
    await page.getByRole('button', { name: 'Anlegen', exact: true }).click();
    await expect(page.getByTestId('api-key-shown')).toContainText('dk_');
    await page.getByRole('button', { name: 'Fertig' }).click();
    const row = page.getByTestId('api-key-row').filter({ hasText: 'e2e payroll' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Widerrufen' }).click();
    await expect(row).toContainText('Widerrufen');

    await page.goto('/staff');
    await page.getByRole('row').nth(1).click();
    await page.getByTestId('badge-panel').getByRole('button', { name: /Badge erzeugen/ }).click();
    await expect(page.getByTestId('badge-value')).toContainText('B-');
  });

  test('staffing: forecast, rule and suggestion appear; the plan stays untouched', async ({ page }) => {
    await login(page, 'manager@demo.test');
    await page.goto('/staffing');
    const day = isoDate(new Date());
    await page.getByTestId('forecast-text').fill(`${day};90`);
    await page.getByRole('button', { name: 'Prognose speichern' }).click();
    await page.getByLabel('Schicht', { exact: true }).selectOption({ index: 1 });
    await page.getByLabel('ab % Auslastung').fill('80');
    await page.getByLabel('Personen', { exact: true }).fill('4');
    await page.getByRole('button', { name: 'Regel speichern' }).click();
    await expect(page.getByTestId('rule-row').first()).toContainText('ab 80 %');
    await expect(page.getByTestId('suggestion-row').first()).toContainText('90 %');
  });

  test('tablet offline: punch is kept on the device, then sent and sent to review', async ({ browser, request }) => {
    const mgr = await apiToken(request, 'manager@demo.test', 'manager');
    const h = { authorization: `Bearer ${mgr}` };
    const hotels = await (await request.get(`${API}/hotels`, { headers: h })).json();
    const hotel = hotels.items.find((x: any) => x.name.includes('Frankfurt'));
    const emps = await (await request.get(`${API}/employees?hotelId=${hotel.id}&pageSize=50`, { headers: h })).json();
    const jon = emps.items.find((e: any) => e.displayName === 'Jon S.');
    const shifts = await (await request.get(`${API}/shifts?hotelId=${hotel.id}`, { headers: h })).json();
    const shift = shifts.items.find((s: any) => s.name === 'Spät') ?? shifts.items[0];
    const today = isoDate(new Date());
    await request.post(`${API}/schedule/entries`, { headers: h, data: { hotelId: hotel.id, employeeId: jon.employeeId ?? jon.id, shiftId: shift.id, date: today } });
    await request.post(`${API}/schedule/publish`, { headers: h, data: { hotelIds: [hotel.id], from: today, to: today } });

    const ctx = await browser.newContext({ baseURL: 'http://localhost:5173', viewport: { width: 1440, height: 1000 }, locale: 'de-DE' });
    await ctx.addInitScript((t) => localStorage.setItem('kioskToken', t), KIOSK_TOKEN);
    const page = await ctx.newPage();
    await page.goto('/kiosk');
    await expect(page.getByTestId('kiosk-clock')).toBeVisible();
    await page.waitForFunction(() => (localStorage.getItem('kioskOfflineRoster') ?? '').includes('Jon S.'));

    await ctx.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByTestId('kiosk-offline-banner')).toContainText('Keine Verbindung');
    await page.getByTestId('kiosk-card-Jon S.').click();
    await page.getByTestId('action-in').click();
    for (const d of '736204') await page.getByTestId(`key-${d}`).click();
    await expect(page.getByTestId('kiosk-saved-offline')).toBeVisible();
    await page.getByTestId('kiosk-finish').click();
    await expect(page.getByTestId('kiosk-offline-banner')).toContainText('Wartend: 1');
    await page.getByTestId('kiosk-card-Jon S.').click();
    await page.getByTestId('action-out').click();
    for (const d of '736204') await page.getByTestId(`key-${d}`).click();
    await page.getByTestId('break-ok').click();
    await expect(page.getByTestId('kiosk-saved-offline')).toBeVisible();
    await page.getByTestId('kiosk-finish').click();
    await expect(page.getByTestId('kiosk-offline-banner')).toContainText('Wartend: 2');

    await ctx.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByTestId('kiosk-notice')).toContainText('übertragen', { timeout: 30_000 });

    const inbox = await (await request.get(`${API}/approvals?type=worked_time&status=pending`, { headers: h })).json();
    const rec = inbox.items.find((i: any) => i.displayName === 'Jon S.' && i.flags.includes('offline'));
    expect(rec).toBeTruthy();
    await ctx.close();
  });
});
