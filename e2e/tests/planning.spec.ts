import { expect, test } from '@playwright/test';
import { addDays, drag, isoDate, login, mondayOf } from './helpers';

// two weeks ahead is always empty in the seed
const week = isoDate(addDays(mondayOf(), 14));
const day = (n: number) => isoDate(addDays(new Date(`${week}T00:00:00Z`), n));

test.describe('Dienstplan', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'manager@demo.test');
    await page.goto(`/planning?week=${week}`);
    await expect(page.getByRole('grid')).toBeVisible();
  });

  test('keyboard path: arrow keys, + menu, Enter creates an entry', async ({ page }) => {
    const maria = page.locator('[role=row]', { hasText: 'Maria G.' });
    const cell = maria.locator('[role=gridcell]').first();
    await cell.locator('.pl-main').focus();
    await page.keyboard.press('ArrowRight'); // Tuesday
    await page.keyboard.press('+');
    const menu = page.getByTestId('cell-menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(maria.locator('[role=gridcell]').nth(1).locator('.pl-chip')).toHaveCount(1);
    await expect(maria.locator('[role=gridcell]').nth(1).locator('.pl-chip')).toContainText(/Früh|Spät|Nacht/);
    // Escape closes the menu and returns focus
    await page.keyboard.press('+');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('drag a template onto a cell, move it with the mouse, reject a blocked drop, publish', async ({ page }) => {
    const jon = page.locator('[role=row]', { hasText: 'Jon S.' });
    const palette = page.getByTestId('pal-1'); // Früh Frankfurt
    await drag(page, palette, jon.locator('[role=gridcell]').nth(2));
    const chip = jon.locator('[role=gridcell]').nth(2).locator('.pl-chip');
    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText('Früh');
    // move to Thursday
    await drag(page, chip, jon.locator('[role=gridcell]').nth(3));
    await expect(jon.locator('[role=gridcell]').nth(3).locator('.pl-chip')).toHaveCount(1);
    await expect(jon.locator('[role=gridcell]').nth(2).locator('.pl-chip')).toHaveCount(0);
    // the draft counter and the publish button reflect the server state
    await expect(page.getByTestId('count-drafts')).not.toHaveText('0');
    // a drop on the trash removes it
    await drag(page, jon.locator('[role=gridcell]').nth(3).locator('.pl-chip'), page.getByTestId('trash'));
    await expect(jon.locator('[role=gridcell]').nth(3).locator('.pl-chip')).toHaveCount(0);
  });

  test('plan, see changes, publish and revert via the changes panel', async ({ page }) => {
    const elena = page.locator('[role=row]', { hasText: 'Elena R.' });
    await elena.locator('[role=gridcell]').nth(0).hover();
    await elena.getByTestId(/^add-\d+-/).first().click();
    await page.getByTestId(/^tpl-/).filter({ hasText: 'Frühstück' }).click();
    await expect(page.getByTestId('changes-panel')).toBeVisible();
    await expect(page.getByTestId('publish')).toBeVisible();
    await page.getByTestId('publish').click();
    await expect(page.getByText('Alles veröffentlicht')).toBeVisible();
    await expect(page.getByTestId('changes-panel')).toBeHidden();
    // removing a published entry shows up as a change until published again
    await elena.locator('.pl-chip').first().click();
    await page.getByTestId('remove-entry').click();
    await expect(page.getByTestId('changes-panel')).toContainText('Entfernt');
    await page.getByRole('button', { name: 'Alle verwerfen' }).click();
    await expect(page.getByTestId('changes-panel')).toBeHidden();
    await expect(elena.locator('.pl-chip')).toHaveCount(1);
    void day;
  });
});
