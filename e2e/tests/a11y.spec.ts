import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { KIOSK_TOKEN, login } from './helpers';

// Automated accessibility checks (WCAG 2.1 A/AA rules of axe-core) on the main screens of every role.
// Serious and critical violations fail the build; the keyboard path of the planning grid has its own spec.
async function scan(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const detail = bad.map((v) => `${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.target.join(' ')}`).join('\n');
  expect(bad, `${label}\n${detail}`).toEqual([]);
}

test.describe('Barrierefreiheit', () => {
  test('login, forgotten password and activation pages', async ({ page }) => {
    for (const path of ['/login', '/forgot-password', '/accept-invitation']) {
      await page.goto(path);
      await page.getByRole('heading').first().waitFor();
      await scan(page, path);
    }
  });

  test('tablet: list, PIN entry and registration screen', async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('kioskToken', t), KIOSK_TOKEN);
    await page.goto('/kiosk');
    await expect(page.getByTestId('kiosk-clock')).toBeVisible();
    await scan(page, 'kiosk list');
    await page.getByTestId('kiosk-card-Piotr N.').click();
    await expect(page.getByTestId('key-1')).toBeVisible();
    await scan(page, 'kiosk pin');
  });

  test('manager: planning, requests, live, staff, month, staffing', async ({ page }) => {
    await login(page, 'manager@demo.test');
    for (const path of ['/planning', '/requests', '/live', '/staff', '/month', '/staffing', '/vacation', '/compliance', '/analytics', '/open-shifts', '/announcements']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await scan(page, path);
    }
  });

  test('employee portal on a phone', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: 'http://localhost:5173', viewport: { width: 390, height: 844 }, locale: 'de-DE' });
    const page = await ctx.newPage();
    await login(page, 'maria.garcia');
    for (const path of ['/me', '/me/schedule', '/me/attendance', '/me/vacation', '/me/team', '/me/account']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await scan(page, path);
    }
    await ctx.close();
  });

  test('administration', async ({ page }) => {
    await login(page, 'admin@demo.test', { totp: true, role: /Administration/ });
    for (const path of ['/admin/overview', '/admin/hotels', '/admin/users', '/admin/tablets', '/admin/integrations', '/admin/rules', '/admin/audit']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await scan(page, path);
    }
  });
});
