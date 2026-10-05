import { useState } from 'react';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useTranslation } from 'react-i18next';
import type { Items, WebauthnKeyDto } from '@dienst/shared';
import { api, useGet, useSend, type ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fdatetime } from '../lib/format';
import { ErrorNote, Field, Kicker, PageHead, useToast } from '../components/ui';

/** Security keys and passkeys of the signed-in person (second factor besides the authenticator app). */
export function Security() {
  const { t } = useTranslation();
  const toast = useToast();
  const { me } = useAuth();
  const keys = useGet<Items<WebauthnKeyDto>>('/auth/webauthn/credentials');
  const remove = useSend<number>('DELETE', (id) => `/auth/webauthn/credentials/${id}`);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const supported = browserSupportsWebAuthn();

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const o = await api<{
        options: Parameters<typeof startRegistration>[0]['optionsJSON'];
        challengeToken: string;
      }>('/auth/webauthn/register/options', { method: 'POST', body: {} });
      const response = await startRegistration({ optionsJSON: o.options });
      await api('/auth/webauthn/register/verify', {
        method: 'POST',
        body: { challengeToken: o.challengeToken, name: name.trim() || t('Sicherheitsschlüssel'), response },
      });
      setName('');
      toast(t('Sicherheitsschlüssel hinzugefügt.'));
      void keys.refetch();
    } catch (e) {
      const err = e as ApiError & { name?: string };
      // the person closed the browser dialog: nothing to report
      if (err.name !== 'NotAllowedError') setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ padding: 'var(--space-4)', maxWidth: 720 }}>
      <PageHead kicker={me?.displayName ?? ''} title={t('Sicherheit')} />
      <section
        aria-labelledby="keys-h"
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
      >
        <Kicker>
          <span id="keys-h">{t('Sicherheitsschlüssel und Passkeys')}</span>
        </Kicker>
        <p style={{ margin: 0, fontSize: 14 }}>
          {t(
            'Mit einem Sicherheitsschlüssel oder Passkey meldest du dich ohne Code aus der Authenticator-App an. Er funktioniert nur auf dieser Webadresse und kann nicht auf eine gefälschte Seite hereinfallen.',
          )}
        </p>
        {(keys.data?.items ?? []).length === 0 && (
          <div style={{ fontSize: 14 }}>{t('Noch kein Schlüssel eingerichtet.')}</div>
        )}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {(keys.data?.items ?? []).map((k) => (
            <li
              key={k.id}
              data-testid="webauthn-key"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                padding: '10px 0',
                borderBottom: '1px solid var(--color-divider)',
              }}
            >
              <div style={{ flex: 1 }}>
                <b>{k.name}</b>
                <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
                  {t('Hinzugefügt')} {fdatetime(k.createdAt)}
                  {k.lastUsedAt ? ` · ${t('Zuletzt benutzt')} ${fdatetime(k.lastUsedAt)}` : ''}
                </div>
              </div>
              <button
                className="btn btn-ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate(k.id, { onSuccess: () => void keys.refetch() })}
              >
                {t('Entfernen')}
              </button>
            </li>
          ))}
        </ul>
        {remove.error && <ErrorNote error={remove.error} />}
        {supported ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
            style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}
          >
            <Field label={t('Name des Schlüssels')} htmlFor="key-name">
              <input
                id="key-name"
                className="input"
                value={name}
                maxLength={80}
                placeholder={t('z. B. Büro-Schlüssel')}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <button className="btn btn-primary" disabled={busy} data-testid="add-key">
              {t('Schlüssel hinzufügen')}
            </button>
          </form>
        ) : (
          <div role="note" style={{ fontSize: 13 }}>
            {t('Dieser Browser unterstützt keine Sicherheitsschlüssel.')}
          </div>
        )}
        {error != null && <ErrorNote error={error} />}
      </section>
    </main>
  );
}
