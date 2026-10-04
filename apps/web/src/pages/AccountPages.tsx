import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../lib/api';
import { AuthFrame } from './Login';

export function AcceptInvitation() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get('token');
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (pw.length < 10) return setError(t('Das Passwort braucht mindestens 10 Zeichen.'));
    if (pw !== pw2) return setError(t('Die Passwörter stimmen nicht überein.'));
    setBusy(true);
    try {
      await api('/auth/accept-invitation', {
        body: token ? { token, password: pw } : { username, code, password: pw },
        token: null,
      });
      setDone(true);
    } catch (err) {
      setError(
        t(
          (err as ApiError).status === 429
            ? 'Zu viele Versuche. Bitte warte einen Moment.'
            : 'Einladung ist ungültig oder abgelaufen.',
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <AuthFrame title="Konto aktivieren">
        <div role="status">{t('Passwort gespeichert. Du kannst dich jetzt anmelden.')}</div>
        <Link className="btn btn-primary" to="/login">
          {t('Zur Anmeldung')}
        </Link>
      </AuthFrame>
    );

  return (
    <AuthFrame title={token ? 'Passwort festlegen' : 'Aktivierung mit Code'}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {!token && (
          <>
            <div className="field">
              <label htmlFor="username">{t('Benutzername')}</label>
              <input
                id="username"
                className="input"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="code">{t('Aktivierungscode')}</label>
              <input
                id="code"
                className="input"
                autoCapitalize="characters"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="pw">{t('Neues Passwort')}</label>
          <input
            id="pw"
            className="input"
            type="password"
            autoComplete="new-password"
            placeholder={t('mindestens 10 Zeichen')}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="pw2">{t('Passwort wiederholen')}</label>
          <input
            id="pw2"
            className="input"
            type="password"
            autoComplete="new-password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
          />
        </div>
        <button className="btn btn-primary" disabled={busy}>
          {t('Passwort festlegen')}
        </button>
        {error && (
          <div role="alert" style={{ color: 'var(--warn)', fontSize: 13, fontWeight: 600 }}>
            {error}
          </div>
        )}
      </form>
    </AuthFrame>
  );
}

export function ForgotPassword() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/auth/forgot-password', { body: { email }, token: null });
      setSent(true);
    } catch (err) {
      setError(
        t(
          (err as ApiError).status === 429
            ? 'Zu viele Versuche. Bitte warte einen Moment.'
            : 'Ungültige Anmeldedaten.',
        ),
      );
    }
  };
  return (
    <AuthFrame title="Passwort zurücksetzen">
      {sent ? (
        <div role="status">
          {t('Falls ein Konto mit E-Mail-Adresse existiert, wurde ein Link verschickt.')}
        </div>
      ) : (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div className="field">
            <label htmlFor="email">{t('E-Mail oder Benutzername')}</label>
            <input id="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <button className="btn btn-primary" disabled={!email}>
            {t('Link anfordern')}
          </button>
          {error && (
            <div role="alert" style={{ color: 'var(--warn)', fontSize: 13 }}>
              {error}
            </div>
          )}
        </form>
      )}
      <Link to="/login">{t('Zurück zur Anmeldung')}</Link>
    </AuthFrame>
  );
}
