import { expect, test } from '@playwright/test';
import { login, PASSWORD } from './helpers';

// Chromium's DevTools protocol offers a virtual authenticator, so the real browser flow can be exercised without hardware.
test.describe('Sicherheitsschlüssel', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'virtual authenticators are a Chromium feature');

  test('admin adds a key, signs out and signs in with password and key, without an authenticator code', async ({ page, context }) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });

    await login(page, 'admin@demo.test', { totp: true });
    await page.goto('/security');
    await expect(page.getByRole('heading', { name: 'Sicherheit' })).toBeVisible();
    await page.getByLabel('Name des Schlüssels').fill('Test-Schlüssel');
    await page.getByTestId('add-key').click();
    await expect(page.getByTestId('webauthn-key').filter({ hasText: 'Test-Schlüssel' })).toBeVisible();

    // sign out and in again: password, then the key
    await page.getByRole('button', { name: /Anna Krüger/ }).click();
    await page.getByRole('menuitem', { name: 'Abmelden' }).click();
    await page.goto('/login');
    await page.fill('#login', 'admin@demo.test');
    await page.fill('#password', PASSWORD);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await page.getByTestId('use-key').click();
    await expect(page.getByRole('navigation').first()).toBeVisible();
    await expect(page).not.toHaveURL(/login/);

    // and the key can be removed again (the authenticator app is still set up)
    await page.goto('/security');
    await page.getByTestId('webauthn-key').filter({ hasText: 'Test-Schlüssel' }).getByRole('button', { name: 'Entfernen' }).click();
    await expect(page.getByTestId('webauthn-key')).toHaveCount(0);
  });
});
