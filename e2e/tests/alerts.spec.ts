import { expect, test } from '@playwright/test';
import { addDays, apiToken, isoDate, login, mondayOf } from './helpers';

// far from the weeks other specs use (portal.spec requests vacation about 60 days out for the same employee)
const monday = isoDate(addDays(mondayOf(), 140));
const friday = isoDate(addDays(mondayOf(), 144));

test.describe('Meldungen', () => {
  test('admin: a new vacation request shows up in the bell and is approved from the panel; managers have no bell', async ({
    browser,
    request,
  }) => {
    const maria = await apiToken(request, 'maria.garcia', 'employee');
    const made = await request.post('http://localhost:3000/api/v1/me/time-off-requests', {
      headers: { authorization: `Bearer ${maria}` },
      data: { from: monday, to: friday },
    });
    expect(made.status()).toBe(201);
    const id = (await made.json()).id as number;

    const ctx = await browser.newContext({ baseURL: 'http://localhost:5173', locale: 'de-DE' });
    const page = await ctx.newPage();
    await login(page, 'admin@demo.test', { totp: true, role: /Administration/ });
    await expect(page.getByTestId('alerts-badge')).toBeVisible();
    await page.getByTestId('alerts-bell').click();
    const item = page.getByTestId('alert-item').filter({ hasText: 'Neuer Urlaubsantrag' }).first();
    await expect(item).toContainText('Maria G.');
    await item.getByTestId('alert-approve').click();
    await expect(item).toContainText('Genehmigt');
    await page.getByTestId('alerts-read-all').click();
    await expect(page.getByTestId('alerts-badge')).toBeHidden();

    const mgr = await apiToken(request, 'manager@demo.test', 'manager');
    const forbidden = await request.get('http://localhost:3000/api/v1/admin-alerts', {
      headers: { authorization: `Bearer ${mgr}` },
    });
    expect(forbidden.status()).toBe(403);
    const mctx = await browser.newContext({ baseURL: 'http://localhost:5173', locale: 'de-DE' });
    const m = await mctx.newPage();
    await login(m, 'manager@demo.test');
    await expect(m.getByTestId('alerts-bell')).toHaveCount(0);

    // the request is decided on the server too
    const check = await request.get('http://localhost:3000/api/v1/me/time-off-requests', {
      headers: { authorization: `Bearer ${maria}` },
    });
    expect((await check.json()).items.find((x: { id: number }) => x.id === id).status).toBe('approved');
  });
});
