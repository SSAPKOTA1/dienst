import type { AdminList, CompanyDto, HotelDto, Items } from '@dienst/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, useGet, useSend } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorNote, Kicker, SectionTitle } from '../../components/ui';
import { InviteDialog } from './Users';

export function AdminCompanies() {
  const { t } = useTranslation();
  const companies = useGet<Items<CompanyDto>>('/companies');
  const hotels = useGet<Items<HotelDto>>('/hotels');
  const admins = useGet<AdminList>('/admins');
  const [name, setName] = useState('');
  const create = useSend('POST', '/companies');
  const [adm, setAdm] = useState(false);
  const sa = useAuth().me?.role === 'superAdmin';
  return (
    <div
      style={{
        padding: 'var(--space-4)',
        display: 'grid',
        gap: 'var(--space-4)',
        gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))',
      }}
    >
      <section>
        <SectionTitle>{t('Unternehmen')}</SectionTitle>
        {(companies.data?.items ?? []).map((c) => (
          <div key={c.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--color-divider)' }}>
            <b>{c.name}</b>
            <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
              {t('Toleranz')} {c.graceMinutes} min · {t('PIN-Länge')} {c.pinLength} ·{' '}
              {(hotels.data?.items ?? [])
                .filter((h) => h.companyId === c.id)
                .map((h) => h.name)
                .join(', ')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
              {t('Meldungen')}: {t('verspätet ab')} {c.alertLateCheckinMinutes} min ·{' '}
              {t('nicht eingestempelt nach')} {c.alertMissedCheckinMinutes} min ·{' '}
              {t('nicht ausgestempelt nach')} {c.alertMissedCheckoutMinutes} min
            </div>
            {sa && <AlertThresholds company={c} onSaved={() => void companies.refetch()} />}
          </div>
        ))}
        <form
          style={{ display: 'flex', gap: 8, marginTop: 'var(--space-3)' }}
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(
              { name },
              {
                onSuccess: () => {
                  setName('');
                  void companies.refetch();
                },
              },
            );
          }}
        >
          <input
            className="input"
            placeholder={t('Name des Unternehmens')}
            aria-label={t('Name des Unternehmens')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn btn-primary" disabled={!name}>
            {t('Unternehmen anlegen')}
          </button>
        </form>
        <ErrorNote error={create.error} />
      </section>
      <section>
        <SectionTitle>{t('Administration')}</SectionTitle>
        {(admins.data?.items ?? []).map((a) => (
          <div key={a.adminId} style={{ padding: '8px 0', borderBottom: '1px solid var(--color-divider)' }}>
            <b>
              {a.firstName} {a.lastName}
            </b>{' '}
            <span style={{ fontSize: 12 }}>{a.email}</span>
            <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
              {(companies.data?.items ?? [])
                .filter((c) => a.companyIds.includes(c.id))
                .map((c) => c.name)
                .join(', ')}
            </div>
          </div>
        ))}
        <button
          className="btn btn-secondary"
          style={{ marginTop: 'var(--space-3)' }}
          onClick={() => setAdm(true)}
        >
          {t('Benutzer einladen')}
        </button>
        {adm && (
          <InviteDialog
            onClose={() => setAdm(false)}
            onDone={() => {
              setAdm(false);
              void admins.refetch();
            }}
          />
        )}
      </section>
    </div>
  );
}

/** Thresholds of the notification bar (minutes after the planned shift start or end); super admin only. */
function AlertThresholds({ company: c, onSaved }: { company: CompanyDto; onSaved: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({
    alertLateCheckinMinutes: String(c.alertLateCheckinMinutes),
    alertMissedCheckinMinutes: String(c.alertMissedCheckinMinutes),
    alertMissedCheckoutMinutes: String(c.alertMissedCheckoutMinutes),
  });
  const save = useSend('PUT', `/companies/${c.id}`);
  const field = (key: keyof typeof v, label: string, max: number) => (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, gap: 2 }}>
      {t(label)}
      <input
        type="number"
        min={1}
        max={max}
        value={v[key]}
        onChange={(e) => setV({ ...v, [key]: e.target.value })}
        style={{ width: 90 }}
      />
    </label>
  );
  if (!open)
    return (
      <button className="btn btn-secondary" style={{ marginTop: 6 }} onClick={() => setOpen(true)}>
        {t('Schwellen für Meldungen')}
      </button>
    );
  return (
    <form
      style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 6 }}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(
          {
            alertLateCheckinMinutes: Number(v.alertLateCheckinMinutes),
            alertMissedCheckinMinutes: Number(v.alertMissedCheckinMinutes),
            alertMissedCheckoutMinutes: Number(v.alertMissedCheckoutMinutes),
          },
          {
            onSuccess: () => {
              setOpen(false);
              onSaved();
            },
          },
        );
      }}
    >
      {field('alertLateCheckinMinutes', 'Verspätet ab (Min.)', 240)}
      {field('alertMissedCheckinMinutes', 'Nicht eingestempelt nach (Min.)', 240)}
      {field('alertMissedCheckoutMinutes', 'Nicht ausgestempelt nach (Min., höchstens 59)', 59)}
      <button className="btn btn-primary" disabled={save.isPending}>
        {t('Speichern')}
      </button>
      <ErrorNote error={save.error} />
    </form>
  );
}

void api;
void Kicker;

/** Weekday and weekend minimum of a department: sum over its shifts (Mo / Sa defaults). */
