import type { CompanyDto, HotelDto, Items, StaffRolesDto } from '@dienst/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../../lib/api';
import { Dialog, ErrorNote, Field } from '../../components/ui';

function CheckList({
  legend,
  items,
  value,
  onChange,
}: {
  legend: string;
  items: Array<{ id: number; name: string }>;
  value: number[];
  onChange: (v: number[]) => void;
}) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend style={{ fontSize: 12, marginBottom: 5 }}>{legend}</legend>
      {items.map((x) => (
        <label key={x.id} style={{ display: 'flex', gap: 8, fontSize: 14, padding: '3px 0' }}>
          <input
            type="checkbox"
            checked={value.includes(x.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, x.id] : value.filter((i) => i !== x.id))}
          />{' '}
          {x.name}
        </label>
      ))}
    </fieldset>
  );
}

/** Super admin: which staff roles a person has (super admin, admin, manager) and what each of them covers. */
export function RolesDialog({
  userId,
  onClose,
  onDone,
}: {
  userId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const roles = useGet<StaffRolesDto>(`/users/${userId}/roles`);
  const hotels = useGet<Items<HotelDto>>('/hotels');
  const companies = useGet<Items<CompanyDto>>('/companies');
  const save = useSend('PUT', `/users/${userId}/roles`, [['api']]);
  const [sa, setSa] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [adminCompanies, setAdminCompanies] = useState<number[]>([]);
  const [adminHotels, setAdminHotels] = useState<number[]>([]);
  const [manager, setManager] = useState(false);
  const [managerHotels, setManagerHotels] = useState<number[]>([]);
  const r = roles.data;
  useEffect(() => {
    if (!r) return;
    setSa(r.superAdmin);
    setAdmin(!!r.admin);
    setAdminCompanies(r.admin?.companyIds ?? []);
    setAdminHotels(r.admin?.hotelIds ?? []);
    setManager(!!r.manager);
    setManagerHotels(r.manager?.hotelIds ?? []);
  }, [r]);
  const hotelList = (hotels.data?.items ?? []).map((h) => ({
    id: h.id,
    name: h.isActive ? h.name : `${h.name} (${t('inaktiv')})`,
  }));
  const valid =
    (!admin || adminCompanies.length + adminHotels.length > 0) && (!manager || managerHotels.length > 0);
  return (
    <Dialog
      title={`${t('Rollen von')} ${r?.name ?? ''}`.trim()}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!r || !valid || save.isPending}
            onClick={() =>
              save.mutate(
                {
                  superAdmin: sa,
                  admin: admin ? { companyIds: adminCompanies, hotelIds: adminHotels } : null,
                  manager: manager ? { hotelIds: managerHotels } : null,
                },
                { onSuccess: onDone },
              )
            }
          >
            {t('Speichern')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      {r && (
        <>
          <div style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>
            {r.isEmployee
              ? t('Diese Person ist Mitarbeitende. Die Rolle Mitarbeiter bleibt immer bestehen.')
              : t('Diese Person ist keine Mitarbeitende.')}{' '}
            {t('Mit mehreren Rollen wählt die Person bei der Anmeldung, in welcher sie arbeitet.')}
          </div>
          <label style={{ display: 'flex', gap: 8, fontSize: 14, padding: '6px 0' }}>
            <input type="checkbox" checked={sa} onChange={(e) => setSa(e.target.checked)} />
            <span>
              <strong>{t('Super-Admin')}</strong> – {t('legt Unternehmen, Hotels und Administration an')}
            </span>
          </label>
          <label style={{ display: 'flex', gap: 8, fontSize: 14, padding: '6px 0' }}>
            <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
            <span>
              <strong>{t('Administration')}</strong> – {t('verwaltet Mitarbeitende, Regeln und Leitungen')}
            </span>
          </label>
          {admin && (
            <div style={{ paddingLeft: 24, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              <CheckList
                legend={t('Ganze Unternehmen (alle ihre Hotels)')}
                items={companies.data?.items ?? []}
                value={adminCompanies}
                onChange={setAdminCompanies}
              />
              <CheckList
                legend={t('Einzelne Hotels')}
                items={hotelList}
                value={adminHotels}
                onChange={setAdminHotels}
              />
              {adminCompanies.length + adminHotels.length === 0 && (
                <div role="alert" style={{ fontSize: 12 }}>
                  {t('Wähle mindestens ein Unternehmen oder Hotel.')}
                </div>
              )}
            </div>
          )}
          <label style={{ display: 'flex', gap: 8, fontSize: 14, padding: '6px 0' }}>
            <input type="checkbox" checked={manager} onChange={(e) => setManager(e.target.checked)} />
            <span>
              <strong>{t('Leitung')}</strong> – {t('plant und gibt frei für die gewählten Hotels')}
            </span>
          </label>
          {manager && (
            <div style={{ paddingLeft: 24 }}>
              <CheckList
                legend={t('Zugriff auf Hotels')}
                items={hotelList}
                value={managerHotels}
                onChange={setManagerHotels}
              />
              {managerHotels.length === 0 && (
                <div role="alert" style={{ fontSize: 12 }}>
                  {t('Wähle mindestens ein Hotel.')}
                </div>
              )}
            </div>
          )}
        </>
      )}
      <Field label="">
        <ErrorNote error={save.error ?? roles.error} />
      </Field>
    </Dialog>
  );
}
