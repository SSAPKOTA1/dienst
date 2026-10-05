import type { AdminList, CompanyDto, HotelDto, Items } from '@dienst/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, useGet, useSend } from '../../lib/api';
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

void api;
void Kicker;

/** Weekday and weekend minimum of a department: sum over its shifts (Mo / Sa defaults). */
