import { expect, test } from '@playwright/test';
import { login } from './helpers';

test.describe('Planungsregeln weich oder hart', () => {
  test('admin sets a restriction to hard, it is kept, and statutory limits cannot be changed', async ({ page }) => {
    await login(page, 'admin@demo.test', { totp: true, role: /Administration/ });
    await page.goto('/admin/rules');
    const section = page.getByRole('region', { name: 'Planungsregeln: weich oder hart' });
    await expect(section).toBeVisible();

    const row = section.getByTestId('sev-row-DAILY_OVER_8H');
    await expect(row.getByRole('button', { name: 'Weich: nur Warnung' })).toHaveAttribute('aria-pressed', 'true');
    // an absence is hard by default and can be made soft
    const absence = section.getByTestId('sev-row-ABSENCE_CONFLICT');
    await expect(absence.getByRole('button', { name: 'Hart: nicht planbar' })).toHaveAttribute('aria-pressed', 'true');

    await row.getByRole('button', { name: 'Hart: nicht planbar' }).click();
    await absence.getByRole('button', { name: 'Weich: nur Warnung' }).click();
    await section.getByTestId('sev-save').click();
    await expect(section.getByText('Angepasst')).toBeVisible();

    await page.reload();
    const again = page.getByRole('region', { name: 'Planungsregeln: weich oder hart' });
    await expect(again.getByTestId('sev-row-DAILY_OVER_8H').getByRole('button', { name: 'Hart: nicht planbar' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(again.getByTestId('sev-row-ABSENCE_CONFLICT').getByRole('button', { name: 'Weich: nur Warnung' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // statutory and technical limits are listed, with no control to change them
    const locked = again.getByTestId('sev-locked');
    await expect(locked).toContainText('Mehr als 10 Stunden pro Tag (Gesetz)');
    await expect(locked).toContainText('Überschneidung mit einer anderen Schicht');
    await expect(locked.getByRole('button')).toHaveCount(0);

    // back to the defaults
    await again.getByRole('button', { name: 'Auf Standard zurücksetzen' }).click();
    await expect(again.getByText('Standardeinstellung')).toBeVisible();
    await expect(again.getByTestId('sev-row-DAILY_OVER_8H').getByRole('button', { name: 'Weich: nur Warnung' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
