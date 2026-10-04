import { expect, test } from '@playwright/test';
import { addDays, apiToken, isoDate, login, mondayOf } from './helpers';

// three weeks ahead the seed has no entries
const tuesday = isoDate(addDays(mondayOf(), 22));

test.describe('Zusammenarbeit', () => {
  test('swap: Maria offers a shift, Jon takes it over, the manager approves', async ({ browser, request }) => {
    const mgr = await apiToken(request, 'manager@demo.test', 'manager');
    const h = { authorization: `Bearer ${mgr}` };
    const hotels = await (await request.get('http://localhost:3000/api/v1/hotels', { headers: h })).json();
    const hotel = hotels.items.find((x: any) => x.name.includes('Frankfurt'));
    const emps = await (await request.get(`http://localhost:3000/api/v1/employees?hotelId=${hotel.id}&pageSize=50`, { headers: h })).json();
    const maria = emps.items.find((e: any) => e.displayName === 'Maria G.');
    const shifts = await (await request.get(`http://localhost:3000/api/v1/shifts?hotelId=${hotel.id}`, { headers: h })).json();
    const early = shifts.items.find((s: any) => s.name === 'Früh' && s.startTime === '06:00');
    const made = await request.post('http://localhost:3000/api/v1/schedule/entries', { headers: h, data: { hotelId: hotel.id, employeeId: maria.employeeId ?? maria.id, shiftId: early.id, date: tuesday } });
    expect(made.status()).toBe(201);
    await request.post('http://localhost:3000/api/v1/schedule/publish', { headers: h, data: { hotelIds: [hotel.id], from: tuesday, to: addDays(new Date(tuesday), 6).toISOString().slice(0, 10) } });

    const mctx = await browser.newContext({ baseURL: 'http://localhost:5173', viewport: { width: 390, height: 844 }, locale: 'de-DE' });
    const m = await mctx.newPage();
    await login(m, 'maria.garcia');
    await m.goto('/me/schedule');
    for (let i = 0; i < 3; i++) await m.getByRole('button', { name: 'Nächste Woche' }).click();
    await m.getByTestId('swap-btn').first().click();
    await m.getByTestId('swap-send').click();
    await expect(m.getByRole('dialog')).toBeHidden();

    const jctx = await browser.newContext({ baseURL: 'http://localhost:5173', viewport: { width: 390, height: 844 }, locale: 'de-DE' });
    const j = await jctx.newPage();
    await login(j, 'jon.schmidt');
    await j.goto('/me/team');
    await j.getByTestId('swap-row').filter({ hasText: 'Angebot' }).first().getByTestId('swap-accept').click();
    await expect(j.getByTestId('swap-row').first()).toContainText('wartet auf Freigabe');

    const pctx = await browser.newContext({ baseURL: 'http://localhost:5173', viewport: { width: 1440, height: 1000 }, locale: 'de-DE' });
    const p = await pctx.newPage();
    await login(p, 'manager@demo.test');
    await p.goto('/requests');
    const req = p.getByTestId('swap-req').first();
    await expect(req).toContainText('Maria G.');
    await req.getByRole('button', { name: 'Freigeben' }).click();
    await expect(p.getByTestId('swap-req')).toHaveCount(0);
    await mctx.close();
    await jctx.close();
    await pctx.close();
  });

  test('open shift: the manager publishes a slot, an employee applies, the manager schedules them', async ({ browser }) => {
    const pctx = await browser.newContext({ baseURL: 'http://localhost:5173', viewport: { width: 1440, height: 1000 }, locale: 'de-DE' });
    const p = await pctx.newPage();
    await login(p, 'manager@demo.test');
    await p.goto('/open-shifts');
    await p.getByTestId('open-new').click();
    await p.getByLabel('Datum').fill(isoDate(addDays(mondayOf(), 24)));
    await p.getByTestId('open-save').click();
    await expect(p.getByTestId('open-row').first()).toBeVisible();

    const ectx = await browser.newContext({ baseURL: 'http://localhost:5173', viewport: { width: 390, height: 844 }, locale: 'de-DE' });
    const e = await ectx.newPage();
    await login(e, 'aylin.demir');
    await e.goto('/me/team');
    await e.getByTestId('open-claim').first().click();
    await expect(e.getByTestId('open-shift').first()).toContainText('Bewerbung zurückziehen');

    await p.goto('/requests');
    const claim = p.getByTestId('claim-row').first();
    await expect(claim).toContainText('Aylin D.');
    await claim.getByRole('button', { name: 'Einplanen' }).click();
    await expect(p.getByTestId('claim-row')).toHaveCount(0);
    await pctx.close();
    await ectx.close();
  });

  test('announcement with read confirmation, feed post, question to management', async ({ browser }) => {
    const pctx = await browser.newContext({ baseURL: 'http://localhost:5173', viewport: { width: 1440, height: 1000 }, locale: 'de-DE' });
    const p = await pctx.newPage();
    await login(p, 'manager@demo.test');
    await p.goto('/announcements');
    await p.getByTestId('ann-new').click();
    const d = p.getByRole('dialog');
    await d.getByLabel('Titel').fill('Brandschutzübung');
    await d.getByLabel('Text').fill('Freitag 10 Uhr in der Lobby.');
    await d.getByLabel('Lesebestätigung verlangen').check();
    await d.getByTestId('ann-save').click();
    await expect(p.getByTestId('ann-row').filter({ hasText: 'Brandschutzübung' })).toContainText('0/');

    const ectx = await browser.newContext({ baseURL: 'http://localhost:5173', viewport: { width: 390, height: 844 }, locale: 'de-DE' });
    const e = await ectx.newPage();
    await login(e, 'maria.garcia');
    await e.goto('/me/team');
    const a = e.getByTestId('announcement').filter({ hasText: 'Brandschutzübung' });
    await a.getByTestId('ann-ack').click();
    await expect(a).toContainText('Bestätigt');
    await e.getByTestId('feed-input').fill('Neue Frühstückskarte ab Montag!');
    await e.getByTestId('feed-post').click();
    await expect(e.getByTestId('feed-post-item').first()).toContainText('Neue Frühstückskarte');
    await e.getByTestId('ask-new').click();
    await e.getByLabel('Betreff').fill('Urlaub');
    await e.getByLabel('Deine Frage').fill('Kann ich im Dezember frei bekommen?');
    await e.getByRole('dialog').getByRole('button', { name: 'Senden' }).click();
    await expect(e.getByTestId('question-row').first()).toContainText('offen');

    await p.goto('/requests');
    const q = p.getByTestId('question-req').filter({ hasText: 'Urlaub' });
    await q.getByRole('button', { name: 'Antworten' }).click();
    await p.getByLabel('Antwort', { exact: true }).fill('Ja, bitte als Antrag.');
    await p.getByRole('button', { name: 'Antwort senden' }).click();
    await expect(q).toHaveCount(0);
    await e.reload();
    await expect(e.getByTestId('question-row').first()).toContainText('Ja, bitte als Antrag.');
    await p.goto('/announcements');
    await expect(p.getByTestId('ann-row').filter({ hasText: 'Brandschutzübung' })).toContainText('1/');
    await pctx.close();
    await ectx.close();
  });

  test('documents: admin uploads a PDF, the employee downloads it; calendar link and availability', async ({ browser }) => {
    const actx = await browser.newContext({ baseURL: 'http://localhost:5173', viewport: { width: 1440, height: 1000 }, locale: 'de-DE' });
    const a = await actx.newPage();
    await login(a, 'admin@demo.test', { totp: true, role: /Administration/ });
    await a.goto('/staff');
    await a.getByText(/^Fatima A/).first().click();
    await a.getByTestId('doc-new').click();
    await a.setInputFiles('#doc-file', { name: 'vertrag.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
    await a.getByTestId('doc-save').click();
    await expect(a.getByTestId('doc-row').first()).toContainText('vertrag');

    const ectx = await browser.newContext({ baseURL: 'http://localhost:5173', viewport: { width: 390, height: 844 }, locale: 'de-DE' });
    const e = await ectx.newPage();
    await login(e, 'fatima.ali');
    await e.goto('/me/account');
    const [dl] = await Promise.all([e.waitForEvent('download'), e.getByTestId('my-doc').first().getByRole('button', { name: 'Herunterladen' }).click()]);
    expect(dl.suggestedFilename()).toBe('vertrag.pdf');
    await e.getByTestId('feed-create').click();
    await expect(e.getByTestId('feed-url')).toContainText('/api/v1/feeds/');
    await e.getByTestId('avail-new').click();
    await e.getByLabel('Anmerkung (optional)').fill('Abendkurs');
    await e.getByRole('dialog').getByRole('button', { name: 'Speichern' }).click();
    await expect(e.getByTestId('avail-row').first()).toContainText('Abendkurs');
    await actx.close();
    await ectx.close();
  });
});
