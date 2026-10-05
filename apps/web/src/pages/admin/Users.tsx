import type { CompanyDto, HotelDto, Items, UserList } from '@dienst/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fdate } from '../../lib/format';
import { Dialog, ErrorNote, Field, Segmented } from '../../components/ui';

export function AdminUsers() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const users = useGet<UserList>('/users', { q: q || undefined, pageSize: 100 });
  const [dlg, setDlg] = useState(false);
  const roleName = (r: string) =>
    r === 'superAdmin'
      ? 'Super-Admin'
      : r === 'admin'
        ? 'Administration'
        : r === 'manager'
          ? 'Leitung'
          : 'Mitarbeiter';
  return (
    <div
      style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 20, marginRight: 'auto' }}>{t('Benutzer und Rollen')}</h2>
        <input
          className="input"
          style={{ width: 220 }}
          placeholder={t('Name suchen')}
          aria-label={t('Name suchen')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn btn-primary" onClick={() => setDlg(true)}>
          {t('Benutzer einladen')}
        </button>
      </div>
      <div style={{ overflowX: 'auto', border: '2px solid var(--color-text)' }}>
        <table className="table" style={{ minWidth: 760 }}>
          <thead>
            <tr>
              <th style={{ paddingLeft: 'var(--space-4)' }}>{t('Name')}</th>
              <th>{t('Rolle')}</th>
              <th>{t('Zugriff auf Hotels')}</th>
              <th>{t('Letzte Anmeldung')}</th>
              <th>{t('Status')}</th>
            </tr>
          </thead>
          <tbody>
            {(users.data?.items ?? []).map((u) => (
              <tr key={u.userId} style={{ opacity: u.status === 'disabled' ? 0.5 : 1 }}>
                <td style={{ paddingLeft: 'var(--space-4)' }}>
                  <div style={{ fontWeight: 700 }}>{u.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-neutral-700)' }}>{u.login}</div>
                </td>
                <td>{u.roles.map((r) => t(roleName(r.role))).join(', ')}</td>
                <td>
                  {u.roles
                    .flatMap((r) =>
                      r.hotelNames.length ? r.hotelNames : r.companyName ? [r.companyName] : [],
                    )
                    .join(', ')}
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {u.lastLoginAt ? fdate(u.lastLoginAt) : t('nie')}
                </td>
                <td>
                  <span className={`tag ${u.status === 'active' ? 'tag-accent' : 'tag-neutral'}`}>
                    {t(
                      u.status === 'active'
                        ? 'Aktiv'
                        : u.status === 'pending_invite'
                          ? 'Einladung offen'
                          : 'Gesperrt',
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
        {t('Neue Benutzer erhalten einen Einladungslink und legen ihr Passwort selbst fest.')}
      </div>
      {dlg && (
        <InviteDialog
          onClose={() => setDlg(false)}
          onDone={() => {
            setDlg(false);
            void users.refetch();
          }}
        />
      )}
    </div>
  );
}

export function InviteDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const hotels = useGet<Items<HotelDto>>('/hotels');
  const companies = useGet<Items<CompanyDto>>('/companies');
  const [kind, setKind] = useState<'manager' | 'admin'>('manager');
  const [f, setF] = useState({ email: '', firstName: '', lastName: '' });
  const [sel, setSel] = useState<number[]>([]);
  const m = useSend('POST', kind === 'manager' ? '/managers' : '/admins');
  const list: Array<HotelDto | CompanyDto> =
    kind === 'manager' ? (hotels.data?.items ?? []) : (companies.data?.items ?? []);
  useEffect(() => setSel([]), [kind]);
  return (
    <Dialog
      title={t('Benutzer einladen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!f.email || !f.firstName || !f.lastName || !sel.length}
            onClick={() =>
              m.mutate(
                { ...f, ...(kind === 'manager' ? { hotelIds: sel } : { companyIds: sel }) },
                { onSuccess: onDone },
              )
            }
          >
            {t('Einladen')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      {me?.role === 'superAdmin' && (
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: 'manager', label: t('Leitung') },
            { value: 'admin', label: t('Administration') },
          ]}
        />
      )}
      <Field label={t('Vorname')} htmlFor="iv1">
        <input
          id="iv1"
          className="input"
          value={f.firstName}
          onChange={(e) => setF({ ...f, firstName: e.target.value })}
        />
      </Field>
      <Field label={t('Nachname')} htmlFor="iv2">
        <input
          id="iv2"
          className="input"
          value={f.lastName}
          onChange={(e) => setF({ ...f, lastName: e.target.value })}
        />
      </Field>
      <Field label={t('E-Mail')} htmlFor="iv3">
        <input
          id="iv3"
          type="email"
          className="input"
          value={f.email}
          onChange={(e) => setF({ ...f, email: e.target.value })}
        />
      </Field>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontSize: 12, marginBottom: 5 }}>
          {kind === 'manager' ? t('Zugriff auf Hotels') : t('Unternehmen')}
        </legend>
        {list.map((x) => (
          <label key={x.id} style={{ display: 'flex', gap: 8, fontSize: 14, padding: '3px 0' }}>
            <input
              type="checkbox"
              checked={sel.includes(x.id)}
              onChange={(e) => setSel(e.target.checked ? [...sel, x.id] : sel.filter((i) => i !== x.id))}
            />{' '}
            {x.name}
          </label>
        ))}
      </fieldset>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- companies (super admin)
