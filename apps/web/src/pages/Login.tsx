import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError, setToken } from '../lib/api';
import { homePathFor, useAuth, type AvailableRole, type RoleName } from '../lib/auth';
import { LangSwitch } from '../components/LangSwitch';

type Step = 'credentials' | 'totp' | 'role' | 'setup2fa';

export const roleLabel = (r: RoleName) =>
  r === 'superAdmin'
    ? 'Super-Admin'
    : r === 'admin'
      ? 'Administration'
      : r === 'manager'
        ? 'Leitung'
        : 'Mitarbeiter';

export function AuthFrame({ children, title }: { children: React.ReactNode; title: string }) {
  const { t } = useTranslation();
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          padding: 'var(--space-2) var(--space-4)',
          borderBottom: '2px solid var(--color-divider)',
        }}
      >
        <LangSwitch />
      </div>
      <main style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))' }}>
        <section
          style={{
            background: 'var(--color-accent)',
            color: 'var(--color-bg)',
            padding: 'var(--space-8)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            minHeight: 360,
          }}
        >
          <div style={{ fontSize: 13, letterSpacing: '.1em', textTransform: 'uppercase', fontWeight: 700 }}>
            Trip Inn Hotels
          </div>
          <h1
            style={{ margin: 'var(--space-2) 0 0', fontSize: 72, lineHeight: 0.95, letterSpacing: '-.02em' }}
          >
            {t('Dienstplan & Zeiterfassung')}
          </h1>
        </section>
        <section
          style={{
            padding: 'var(--space-8)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 'var(--space-4)',
            maxWidth: 480,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 28 }}>{t(title)}</h2>
          {children}
        </section>
      </main>
    </div>
  );
}

export function Login() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { me, setSession } = useAuth();
  const [step, setStep] = useState<Step>('credentials');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [roles, setRoles] = useState<AvailableRole[]>([]);
  const [pre, setPre] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [params] = useSearchParams();
  const [ssoOpen, setSsoOpen] = useState(false);
  const [company, setCompany] = useState('');
  const ssoError = params.get('sso_error');

  if (me) return <Navigate to={homePathFor(me.role)} replace />;

  const fail = (e: unknown) => {
    const err = e as ApiError;
    if (err.status === 429) setError(t('Zu viele Versuche. Bitte warte einen Moment.'));
    else if (err.details?.totpRequired) {
      setStep('totp');
      setError(null);
    } else setError(t(step === 'totp' ? 'Ungültiger Code.' : 'Ungültige Anmeldedaten.'));
  };

  const finish = (token: string) => {
    setSession(token);
    nav('/', { replace: true });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api('/auth/login', { body: { login, password, totp: totp || undefined }, token: null });
      if (r.accessToken) return finish(r.accessToken);
      setPre(r.preToken);
      setRoles(r.availableRoles);
      if (r.twoFactorSetupRequired) {
        const s = await api('/auth/2fa/setup', { body: {}, token: r.preToken });
        setSetup(s);
        setStep('setup2fa');
      } else setStep('role');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (r: AvailableRole, token = pre) => {
    setBusy(true);
    try {
      const s = await api('/auth/select-role', { body: { role: r.role, employeeId: r.employeeId }, token });
      finish(s.accessToken);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const verify2fa = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/2fa/verify', { body: { code }, token: pre });
      setStep('role');
      if (roles.length === 1) await pick(roles[0]);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'role') {
    return (
      <AuthFrame title="Rolle wählen">
        <div style={{ fontSize: 14 }}>{t('Mit welcher Rolle möchtest du arbeiten?')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {roles.map((r) => (
            <button
              key={`${r.role}-${r.employeeId ?? ''}`}
              className="btn btn-secondary"
              style={{ justifyContent: 'space-between', padding: '12px 14px' }}
              disabled={busy}
              onClick={() => void pick(r)}
            >
              <span>{t(roleLabel(r.role))}</span>
              <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--color-neutral-700)' }}>
                {r.companyName ?? r.hotelNames?.join(', ') ?? ''}
              </span>
            </button>
          ))}
        </div>
        {error && (
          <div role="alert" style={{ color: 'var(--warn)', fontSize: 13 }}>
            {error}
          </div>
        )}
      </AuthFrame>
    );
  }

  if (step === 'setup2fa' && setup) {
    return (
      <AuthFrame title="Zwei-Faktor-Anmeldung einrichten">
        <div style={{ fontSize: 14 }}>
          {t('Scanne den QR-Code mit einer Authenticator-App und gib den 6-stelligen Code ein.')}
        </div>
        <img
          src={setup.qrDataUrl}
          alt="QR"
          width={180}
          height={180}
          style={{ border: '1px solid var(--color-divider)' }}
        />
        <div style={{ fontSize: 12 }}>
          {t('Geheimer Schlüssel')}: <code>{setup.secret}</code>
        </div>
        <form
          onSubmit={verify2fa}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
        >
          <div className="field">
            <label htmlFor="code">{t('Anmeldecode')}</label>
            <input
              id="code"
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <button className="btn btn-primary" disabled={busy}>
            {t('Bestätigen')}
          </button>
          {error && (
            <div role="alert" style={{ color: 'var(--warn)', fontSize: 13 }}>
              {error}
            </div>
          )}
        </form>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Anmelden">
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className="field">
          <label htmlFor="login">{t('E-Mail oder Benutzername')}</label>
          <input
            id="login"
            className="input"
            placeholder="maria.garcia"
            autoComplete="username"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            autoFocus
          />
        </div>
        <div className="field">
          <label htmlFor="password">{t('Passwort')}</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            placeholder={t('mindestens 10 Zeichen')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {step === 'totp' && (
          <div className="field">
            <label htmlFor="totp">{t('Code aus deiner Authenticator-App')}</label>
            <input
              id="totp"
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              autoFocus
            />
          </div>
        )}
        <button
          className="btn btn-primary btn-block"
          style={{ marginTop: 0 }}
          disabled={busy || !login || !password}
        >
          {busy ? t('Anmelden…') : t('Anmelden')}
        </button>
        {error && (
          <div role="alert" style={{ color: 'var(--warn)', fontSize: 13, fontWeight: 600 }}>
            {error}
          </div>
        )}
      </form>
      {ssoError && (
        <div
          role="alert"
          data-testid="sso-error"
          style={{ color: 'var(--warn)', fontSize: 13, fontWeight: 600 }}
        >
          {t(
            ssoError === 'no_account'
              ? 'Für dieses Firmenkonto gibt es kein Konto in der App. Bitte die Administration fragen.'
              : 'Die Anmeldung mit dem Firmenkonto hat nicht geklappt.',
          )}
        </div>
      )}
      <button type="button" className="btn btn-secondary" onClick={() => setSsoOpen(!ssoOpen)}>
        {t('Mit Firmenkonto anmelden')}
      </button>
      {ssoOpen && (
        <form
          style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end' }}
          onSubmit={(e) => {
            e.preventDefault();
            window.location.href = `/api/v1/auth/sso/start?company=${encodeURIComponent(company.trim())}`;
          }}
        >
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="sso-company">{t('Firmennummer')}</label>
            <input
              id="sso-company"
              className="input"
              inputMode="numeric"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
          </div>
          <button className="btn btn-primary" disabled={!/^\d+$/.test(company.trim())}>
            {t('Weiter')}
          </button>
        </form>
      )}
      <button
        type="button"
        className="btn btn-ghost"
        style={{ alignSelf: 'flex-start' }}
        onClick={() => setForgot(!forgot)}
      >
        {t('Passwort vergessen?')}
      </button>
      {forgot && (
        <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)', fontSize: 13 }}>
          {t(
            'Mit E-Mail-Adresse: Du bekommst einen Link, falls ein Konto existiert. Ohne E-Mail-Adresse: Bitte deine Leitung um einen Link zum Zurücksetzen.',
          )}{' '}
          <Link to="/forgot-password">{t('Link anfordern')}</Link>
        </div>
      )}
      <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
        {t(
          'Neu hier? Öffne den Einladungslink, den du per E-Mail oder persönlich bekommen hast, und lege dein Passwort selbst fest.',
        )}{' '}
        <Link to="/accept-invitation">{t('Ich habe einen Aktivierungscode')}</Link>
      </div>
    </AuthFrame>
  );
}

/** Landing page of the single sign-on redirect: trades the one-time ticket for a session. */
export function SsoCallback() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { setSession } = useAuth();
  const [roles, setRoles] = useState<AvailableRole[] | null>(null);
  const [pre, setPre] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const ticket = new URLSearchParams(window.location.hash.slice(1)).get('ticket');
    window.history.replaceState(null, '', window.location.pathname);
    if (!ticket) return setError(t('Die Anmeldung ist abgelaufen. Bitte noch einmal versuchen.'));
    api('/auth/sso/exchange', { body: { ticket }, token: null })
      .then((r) => {
        if (r.accessToken) {
          setSession(r.accessToken);
          nav('/', { replace: true });
        } else {
          setPre(r.preToken);
          setRoles(r.availableRoles);
        }
      })
      .catch((e: ApiError) =>
        setError(
          e.details?.adminNeedsMfa
            ? t('Administratoren brauchen beim Firmenkonto eine Zwei-Faktor-Anmeldung.')
            : t('Die Anmeldung mit dem Firmenkonto hat nicht geklappt.'),
        ),
      );
  }, [nav, setSession, t]);
  const pick = async (r: AvailableRole) => {
    try {
      const s = await api('/auth/select-role', {
        body: { role: r.role, employeeId: r.employeeId },
        token: pre,
      });
      setSession(s.accessToken);
      nav('/', { replace: true });
    } catch {
      setError(t('Die Anmeldung mit dem Firmenkonto hat nicht geklappt.'));
    }
  };
  return (
    <AuthFrame title={roles ? 'Rolle wählen' : 'Anmelden'}>
      {error && (
        <>
          <div role="alert" style={{ color: 'var(--warn)', fontWeight: 600 }}>
            {error}
          </div>
          <Link to="/login">{t('Zurück zur Anmeldung')}</Link>
        </>
      )}
      {!error && !roles && <div>{t('Einen Moment …')}</div>}
      {roles && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {roles.map((r) => (
            <button
              key={`${r.role}-${r.employeeId ?? ''}`}
              className="btn btn-secondary"
              onClick={() => void pick(r)}
            >
              {t(roleLabel(r.role))} {r.companyName ?? ''}
            </button>
          ))}
        </div>
      )}
    </AuthFrame>
  );
}

void setToken;
