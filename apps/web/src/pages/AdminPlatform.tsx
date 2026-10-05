import type {
  ApiKeyList,
  CompanyDto,
  HotelDto,
  HotelSettingsFull,
  Items,
  SsoProviderDto,
} from '@dienst/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../lib/api';
import { fdatetime } from '../lib/format';
import { Dialog, ErrorNote, Field, Toggle, useToast } from '../components/ui';

const box: React.CSSProperties = { border: '2px solid var(--color-text)' };
const wrap: React.CSSProperties = {
  padding: 'var(--space-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-4)',
};

// ---------------------------------------------------------------- time recording options per hotel
export function HotelPlatformSettings({ hotelId }: { hotelId: number }) {
  const { t } = useTranslation();
  const toast = useToast();
  const s = useGet<HotelSettingsFull>(`/hotels/${hotelId}/settings`);
  const save = useSend<Record<string, unknown>>('PUT', `/hotels/${hotelId}/settings`, [['api']]);
  const [cidrs, setCidrs] = useState('');
  useEffect(() => setCidrs((s.data?.webPunchAllowedCidrs ?? []).join(', ')), [s.data]);
  if (!s.data) return null;
  const apply = (body: Record<string, unknown>) =>
    save.mutate(body, { onSuccess: () => toast(t('Gespeichert.')) });
  const parsed = cidrs
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return (
    <div
      data-testid={`platform-settings-${hotelId}`}
      style={{
        padding: 'var(--space-3) var(--space-4)',
        borderTop: '2px solid var(--color-divider)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      <div style={{ fontWeight: 800, fontSize: 14 }}>{t('Zeiterfassung')}</div>
      <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
        <Field label={t('Pausen am Tablet')} htmlFor={`bm-${hotelId}`}>
          <select
            id={`bm-${hotelId}`}
            className="input"
            value={s.data.breakMode}
            onChange={(e) => apply({ breakMode: e.target.value })}
          >
            <option value="confirm_at_clock_out">{t('Beim Ausstempeln bestätigen')}</option>
            <option value="start_stop">{t('Pause starten und beenden')}</option>
          </select>
        </Field>
        <Field label={t('Anmeldung am Tablet')} htmlFor={`ki-${hotelId}`}>
          <select
            id={`ki-${hotelId}`}
            className="input"
            value={s.data.kioskIdentification}
            onChange={(e) => apply({ kioskIdentification: e.target.value })}
          >
            <option value="name_pin">{t('Name und PIN')}</option>
            <option value="badge_pin">{t('Badge (NFC/QR) und PIN')}</option>
          </select>
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
        <Toggle
          on={!!s.data.allowWebPunch}
          label={t('Web-Stempelung erlauben')}
          onChange={(v) => apply({ allowWebPunch: v })}
        />
        <span style={{ fontWeight: 700 }}>{t('Web-Stempelung erlauben')}</span>
      </div>
      <Field
        label={t('Erlaubte Netzwerke (IP oder CIDR, Komma getrennt)')}
        htmlFor={`cidr-${hotelId}`}
        hint={t('Stempeln im Browser geht nur aus diesen Netzen. Es gibt keine Standortverfolgung.')}
      >
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <input
            id={`cidr-${hotelId}`}
            className="input"
            placeholder="203.0.113.0/24"
            value={cidrs}
            onChange={(e) => setCidrs(e.target.value)}
          />
          <button className="btn btn-secondary" onClick={() => apply({ webPunchAllowedCidrs: parsed })}>
            {t('Speichern')}
          </button>
        </div>
      </Field>
      <ErrorNote error={save.error} />
    </div>
  );
}

// ---------------------------------------------------------------- API keys and SSO
export function AdminIntegrations() {
  const { t } = useTranslation();
  const companies = useGet<Items<CompanyDto>>('/companies');
  return (
    <div style={wrap}>
      <h2 style={{ margin: 0, fontSize: 20 }}>{t('Schnittstellen')}</h2>
      <ApiKeys companies={companies.data?.items ?? []} />
      <Sso companies={companies.data?.items ?? []} />
    </div>
  );
}

const SCOPES: Array<[string, string]> = [
  ['hotels:read', 'Hotels'],
  ['employees:read', 'Mitarbeitende (Name, Personalnummer)'],
  ['schedule:read', 'Veröffentlichte Dienstpläne'],
  ['attendance:read', 'Freigegebene Arbeitszeiten'],
  ['absences:read', 'Genehmigte Abwesenheiten'],
];
const EXPIRY: Array<[number, string]> = [
  [30, '30 Tage'],
  [90, '90 Tage'],
  [180, '180 Tage'],
  [365, '1 Jahr'],
  [730, '2 Jahre'],
];

function ApiKeys({ companies }: { companies: CompanyDto[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const keys = useGet<ApiKeyList>('/api-keys');
  const hotels = useGet<Items<HotelDto>>('/hotels');
  const create = useSend<Record<string, unknown>, { key: string }>('POST', '/api-keys');
  const revoke = useSend<number>('DELETE', (id) => `/api-keys/${id}`);
  const [dlg, setDlg] = useState(false);
  const [name, setName] = useState('');
  const [companyId, setCompanyId] = useState<number | ''>('');
  const [hotelId, setHotelId] = useState<number | ''>('');
  const [shown, setShown] = useState<string | null>(null);
  const [scopes, setScopes] = useState<string[]>(SCOPES.map(([k]) => k));
  const [days, setDays] = useState(365);
  const [cidrs, setCidrs] = useState('');
  const cidrList = cidrs
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const cid = companyId || companies[0]?.id || '';
  return (
    <section style={box}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-3) var(--space-4)',
          background: 'var(--color-surface)',
          borderBottom: '2px solid var(--color-text)',
        }}
      >
        <h3 style={{ margin: 0, fontSize: 18, marginRight: 'auto' }}>{t('API-Schlüssel (nur lesen)')}</h3>
        <a href="/api/public/v1/openapi.json" target="_blank" rel="noreferrer" className="btn btn-ghost">
          {t('API-Beschreibung')}
        </a>
        <button className="btn btn-primary" onClick={() => setDlg(true)}>
          {t('Schlüssel anlegen')}
        </button>
      </div>
      <div style={{ padding: 'var(--space-3) var(--space-4)', fontSize: 13 }}>
        {t(
          'Die öffentliche API liefert veröffentlichte Schichten, freigegebene Stunden und genehmigte Abwesenheiten. Keine Löhne, keine Gesundheitsdaten.',
        )}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th style={{ paddingLeft: 'var(--space-4)' }}>{t('Name')}</th>
            <th>{t('Schlüssel')}</th>
            <th>{t('Hotel')}</th>
            <th>{t('Rechte')}</th>
            <th>{t('Gültig bis')}</th>
            <th>{t('Zuletzt benutzt')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(keys.data?.items ?? []).map((k) => (
            <tr key={k.id} data-testid="api-key-row">
              <td style={{ paddingLeft: 'var(--space-4)', fontWeight: 700 }}>{k.name}</td>
              <td style={{ fontFamily: 'monospace' }}>{k.prefix}…</td>
              <td>
                {k.hotelId
                  ? ((hotels.data?.items ?? []).find((h) => h.id === k.hotelId)?.name ?? k.hotelId)
                  : t('Alle Hotels')}
              </td>
              <td style={{ fontSize: 12 }}>
                {k.scopes.map((x: string) => x.replace(':read', '')).join(', ')}
                {k.allowedCidrs.length ? ` · ${k.allowedCidrs.join(', ')}` : ''}
              </td>
              <td>
                {fdatetime(k.expiresAt)}
                {!k.revokedAt && Date.parse(k.expiresAt) < Date.now() && (
                  <span className="tag tag-accent" style={{ marginLeft: 6 }}>
                    {t('Abgelaufen')}
                  </span>
                )}
                {!k.revokedAt &&
                  Date.parse(k.expiresAt) >= Date.now() &&
                  Date.parse(k.expiresAt) - Date.now() < 30 * 86400e3 && (
                    <span className="tag tag-neutral" style={{ marginLeft: 6 }}>
                      {t('Läuft bald ab')}
                    </span>
                  )}
              </td>
              <td>{k.revokedAt ? t('Widerrufen') : k.lastUsedAt ? fdatetime(k.lastUsedAt) : '–'}</td>
              <td style={{ textAlign: 'right', paddingRight: 'var(--space-4)' }}>
                {!k.revokedAt && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => revoke.mutate(k.id, { onSuccess: () => toast(t('Widerrufen')) })}
                  >
                    {t('Widerrufen')}
                  </button>
                )}
              </td>
            </tr>
          ))}
          {(keys.data?.items ?? []).length === 0 && (
            <tr>
              <td colSpan={7} style={{ paddingLeft: 'var(--space-4)' }}>
                {t('Noch keine Schlüssel.')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {dlg && (
        <Dialog
          title={t('Schlüssel anlegen')}
          onClose={() => setDlg(false)}
          actions={
            <>
              <button
                className="btn btn-primary"
                disabled={!name.trim() || !cid || scopes.length === 0}
                onClick={() =>
                  create.mutate(
                    {
                      companyId: Number(cid),
                      hotelId: hotelId || null,
                      name,
                      scopes,
                      expiresInDays: days,
                      ...(cidrList.length ? { allowedCidrs: cidrList } : {}),
                    },
                    {
                      onSuccess: (r) => {
                        setShown(r.key);
                        setDlg(false);
                        setName('');
                      },
                    },
                  )
                }
              >
                {t('Anlegen')}
              </button>
              <button className="btn btn-ghost" onClick={() => setDlg(false)}>
                {t('Abbrechen')}
              </button>
            </>
          }
        >
          <Field label={t('Name')} htmlFor="ak-name">
            <input id="ak-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {companies.length > 1 && (
            <Field label={t('Unternehmen')} htmlFor="ak-co">
              <select
                id="ak-co"
                className="input"
                value={cid}
                onChange={(e) => {
                  setCompanyId(Number(e.target.value));
                  setHotelId('');
                }}
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label={t('Hotel')} htmlFor="ak-h">
            <select
              id="ak-h"
              className="input"
              value={hotelId}
              onChange={(e) => setHotelId(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">{t('Alle Hotels')}</option>
              {(hotels.data?.items ?? [])
                .filter((h) => h.companyId === Number(cid))
                .map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t('Gültigkeit')} htmlFor="ak-days">
            <select
              id="ak-days"
              className="input"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {EXPIRY.map(([d, l]) => (
                <option key={d} value={d}>
                  {t(l)}
                </option>
              ))}
            </select>
          </Field>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 700, fontSize: 13 }}>{t('Darf lesen')}</legend>
            {SCOPES.map(([k, l]) => (
              <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 28 }}>
                <input
                  type="checkbox"
                  checked={scopes.includes(k)}
                  onChange={(e) =>
                    setScopes(e.target.checked ? [...scopes, k] : scopes.filter((x) => x !== k))
                  }
                />
                {t(l)}
              </label>
            ))}
          </fieldset>
          <Field
            label={t('Erlaubte Netzwerke (optional, IP oder CIDR)')}
            htmlFor="ak-cidr"
            hint={t('Leer: von überall. Sonst nur aus diesen Netzen.')}
          >
            <input
              id="ak-cidr"
              className="input"
              value={cidrs}
              onChange={(e) => setCidrs(e.target.value)}
              placeholder="203.0.113.0/24"
            />
          </Field>
          <ErrorNote error={create.error} />
        </Dialog>
      )}
      {shown && (
        <Dialog
          title={t('Dein API-Schlüssel')}
          onClose={() => setShown(null)}
          actions={
            <button className="btn btn-primary" onClick={() => setShown(null)}>
              {t('Fertig')}
            </button>
          }
        >
          <p style={{ marginTop: 0 }}>
            {t('Dieser Schlüssel wird nur jetzt angezeigt. Bitte sicher aufbewahren.')}
          </p>
          <code
            data-testid="api-key-shown"
            style={{
              display: 'block',
              padding: 'var(--space-3)',
              border: '2px solid var(--color-text)',
              wordBreak: 'break-all',
            }}
          >
            {shown}
          </code>
        </Dialog>
      )}
    </section>
  );
}

function Sso({ companies }: { companies: CompanyDto[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [companyId, setCompanyId] = useState<number | ''>('');
  const cid = companyId || companies[0]?.id || null;
  const cur = useGet<SsoProviderDto>('/sso/provider', cid ? { companyId: String(cid) } : undefined, {
    enabled: !!cid,
  });
  const save = useSend('PUT', '/sso/provider');
  const remove = useSend<number>('DELETE', (id) => `/sso/provider?companyId=${id}`);
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    setIssuer(cur.data?.issuer ?? '');
    setClientId(cur.data?.clientId ?? '');
    setEnabled(cur.data?.enabled ?? true);
    setSecret('');
  }, [cur.data]);
  const configured = cur.data && cur.data.configured !== false;
  return (
    <section style={box}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-3) var(--space-4)',
          background: 'var(--color-surface)',
          borderBottom: '2px solid var(--color-text)',
        }}
      >
        <h3 style={{ margin: 0, fontSize: 18, marginRight: 'auto' }}>
          {t('Single Sign-on (OpenID Connect)')}
        </h3>
        {companies.length > 1 && (
          <select
            className="input"
            style={{ width: 'auto' }}
            aria-label={t('Unternehmen')}
            value={cid ?? ''}
            onChange={(e) => setCompanyId(Number(e.target.value))}
          >
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div
        style={{
          padding: 'var(--space-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
          maxWidth: 640,
        }}
      >
        <div style={{ fontSize: 13 }}>
          {t(
            'Mitarbeitende melden sich mit dem Firmenkonto an. Konten werden nie automatisch angelegt: die E-Mail-Adresse muss zu einem bestehenden Konto passen.',
          )}
        </div>
        <Field label={t('Redirect-URI beim Anbieter eintragen')} htmlFor="sso-redirect">
          <input id="sso-redirect" className="input" readOnly value={cur.data?.redirectUri ?? ''} />
        </Field>
        <Field label={t('Issuer-URL')} htmlFor="sso-issuer">
          <input
            id="sso-issuer"
            className="input"
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
            placeholder="https://login.example.com/realms/hotel"
          />
        </Field>
        <Field label={t('Client-ID')} htmlFor="sso-client">
          <input
            id="sso-client"
            className="input"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
        </Field>
        <Field
          label={t('Client-Secret')}
          htmlFor="sso-secret"
          hint={configured ? t('Leer lassen, um das gespeicherte Secret zu behalten.') : undefined}
        >
          <input
            id="sso-secret"
            className="input"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </Field>
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <Toggle on={enabled} onChange={setEnabled} label={t('Aktiv')} />
          <span style={{ fontWeight: 700 }}>{t('Aktiv')}</span>
        </div>
        <ErrorNote error={save.error} />
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button
            className="btn btn-primary"
            disabled={!cid || !issuer || !clientId || (!configured && !secret)}
            onClick={() =>
              save.mutate(
                { companyId: cid, issuer, clientId, enabled, ...(secret ? { clientSecret: secret } : {}) },
                { onSuccess: () => toast(t('Gespeichert.')) },
              )
            }
          >
            {t('Speichern')}
          </button>
          {configured && (
            <button
              className="btn btn-ghost"
              onClick={() => remove.mutate(cid as number, { onSuccess: () => toast(t('Gelöscht.')) })}
            >
              {t('Entfernen')}
            </button>
          )}
        </div>
        {configured && (
          <div style={{ fontSize: 13 }}>
            {t('Anmeldelink für Mitarbeitende')}:{' '}
            <code>{`${window.location.origin}/api/v1/auth/sso/start?company=${cid}`}</code>
          </div>
        )}
      </div>
    </section>
  );
}
