import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Dialog, ErrorNote, Field, useToast } from '../../components/ui';
import { HotelPlatformSettings } from '../AdminPlatform';
import { ShiftsDialog, minimums } from './Shifts';

export function AdminHotels() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const toast = useToast();
  const hotels = useGet('/hotels');
  const depts = useGet('/departments');
  const shifts = useGet('/shifts');
  const companies = useGet('/companies');
  type Dlg =
    | { kind: 'hotel' }
    | { kind: 'dept'; hotelId: number; dept?: any }
    | { kind: 'shifts'; hotelId: number; dept: any };
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const setVis = useSend<{ id: number; employeeHoursVisibility: string }>(
    'PUT',
    (b) => `/hotels/${b.id}/settings`,
  );
  const delDept = useSend<number>('DELETE', (id) => `/departments/${id}`);
  const sa = me?.role === 'superAdmin';
  return (
    <div
      style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 20, marginRight: 'auto' }}>{t('Hotels und Mindestbesetzung')}</h2>
        {sa && (
          <button className="btn btn-primary" onClick={() => setDlg({ kind: 'hotel' })}>
            {t('Hotel anlegen')}
          </button>
        )}
      </div>
      {(hotels.data?.items ?? []).map((h: any) => (
        <section key={h.id} style={{ border: '2px solid var(--color-text)' }}>
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-3)',
              alignItems: 'center',
              flexWrap: 'wrap',
              padding: 'var(--space-3) var(--space-4)',
              background: 'var(--color-surface)',
              borderBottom: '2px solid var(--color-text)',
            }}
          >
            <h3 style={{ margin: 0, fontSize: 18, marginRight: 'auto' }}>{h.name}</h3>
            <span style={{ fontSize: 13 }}>
              {h.city} · {h.federalState} · {h.timezone}
            </span>
            {me?.role !== 'manager' && (
              <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
                {t('Stunden für Mitarbeitende sichtbar')}
                <select
                  className="input"
                  style={{ width: 'auto', minHeight: 30, padding: '2px 6px' }}
                  value={h.employeeHoursVisibility}
                  onChange={(e) =>
                    setVis.mutate(
                      { id: h.id, employeeHoursVisibility: e.target.value },
                      {
                        onSuccess: () => {
                          toast(t('Gespeichert.'));
                          void hotels.refetch();
                        },
                      },
                    )
                  }
                >
                  <option value="after_approval">{t('nach Freigabe')}</option>
                  <option value="immediately">{t('sofort')}</option>
                </select>
              </label>
            )}
          </div>
          {me?.role !== 'manager' && <HotelPlatformSettings hotelId={h.id} />}
          <table className="table">
            <thead>
              <tr>
                <th style={{ paddingLeft: 'var(--space-4)' }}>{t('Abteilung')}</th>
                <th>{t('Schichten')}</th>
                <th style={{ width: 170 }}>{t('Mindestbesetzung')}</th>
                <th style={{ width: 300 }} />
              </tr>
            </thead>
            <tbody>
              {(depts.data?.items ?? [])
                .filter((d: any) => d.hotelId === h.id)
                .map((d: any) => (
                  <tr key={d.id}>
                    <td style={{ paddingLeft: 'var(--space-4)', fontWeight: 700 }}>{d.name}</td>
                    <td style={{ fontSize: 13 }}>
                      {(shifts.data?.items ?? [])
                        .filter((x: any) => x.departmentId === d.id)
                        .map((x: any) => `${x.name} ${x.startTime}–${x.endTime}`)
                        .join(' · ') || '–'}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {minimums(shifts.data?.items ?? [], d.id)}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="btn btn-ghost"
                        onClick={() => setDlg({ kind: 'shifts', hotelId: h.id, dept: d })}
                      >
                        {t('Schichten & Besetzung')}
                      </button>
                      {me?.role !== 'manager' && (
                        <>
                          <button
                            className="btn btn-ghost"
                            onClick={() => setDlg({ kind: 'dept', hotelId: h.id, dept: d })}
                          >
                            {t('Bearbeiten')}
                          </button>
                          <button
                            className="btn btn-ghost"
                            onClick={() =>
                              window.confirm(t('Abteilung löschen?')) &&
                              delDept.mutate(d.id, { onSuccess: () => void depts.refetch() })
                            }
                          >
                            {t('Löschen')}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          {me?.role !== 'manager' && (
            <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
              <button className="btn btn-secondary" onClick={() => setDlg({ kind: 'dept', hotelId: h.id })}>
                {t('Abteilung hinzufügen')}
              </button>
            </div>
          )}
        </section>
      ))}
      <ErrorNote error={delDept.error} />
      {dlg?.kind === 'hotel' && (
        <HotelDialog
          companies={companies.data?.items ?? []}
          onClose={() => setDlg(null)}
          onDone={() => {
            setDlg(null);
            void hotels.refetch();
          }}
        />
      )}
      {dlg?.kind === 'shifts' && (
        <ShiftsDialog
          hotelId={dlg.hotelId}
          dept={dlg.dept}
          shifts={(shifts.data?.items ?? []).filter((x: any) => x.departmentId === dlg.dept.id)}
          onClose={() => setDlg(null)}
          onChanged={() => void shifts.refetch()}
        />
      )}
      {dlg?.kind === 'dept' && (
        <DeptDialog
          hotelId={dlg.hotelId}
          dept={dlg.dept}
          onClose={() => setDlg(null)}
          onDone={() => {
            setDlg(null);
            void depts.refetch();
          }}
        />
      )}
    </div>
  );
}

function HotelDialog({
  companies,
  onClose,
  onDone,
}: {
  companies: any[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [f, setF] = useState({
    companyId: companies[0]?.id ?? 0,
    name: '',
    city: '',
    federalState: 'HE',
    timezone: 'Europe/Berlin',
  });
  const m = useSend('POST', '/hotels');
  return (
    <Dialog
      title={t('Hotel anlegen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!f.name}
            onClick={() => m.mutate({ ...f, companyId: Number(f.companyId) }, { onSuccess: onDone })}
          >
            {t('Speichern')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Unternehmen')} htmlFor="co">
        <select
          id="co"
          className="input"
          value={f.companyId}
          onChange={(e) => setF({ ...f, companyId: Number(e.target.value) })}
        >
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('Name')} htmlFor="hn">
        <input
          id="hn"
          className="input"
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
        />
      </Field>
      <Field label={t('Stadt')} htmlFor="hc">
        <input
          id="hc"
          className="input"
          value={f.city}
          onChange={(e) => setF({ ...f, city: e.target.value })}
        />
      </Field>
      <Field label={t('Bundesland (Kürzel)')} htmlFor="hs">
        <input
          id="hs"
          className="input"
          maxLength={2}
          value={f.federalState}
          onChange={(e) => setF({ ...f, federalState: e.target.value.toUpperCase() })}
        />
      </Field>
      <Field label={t('Zeitzone')} htmlFor="tz">
        <input
          id="tz"
          className="input"
          value={f.timezone}
          onChange={(e) => setF({ ...f, timezone: e.target.value })}
        />
      </Field>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}

function DeptDialog({
  hotelId,
  dept,
  onClose,
  onDone,
}: {
  hotelId: number;
  dept?: any;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(dept?.name ?? '');
  const create = useSend('POST', '/departments');
  const update = useSend('PUT', `/departments/${dept?.id}`);
  const m = dept ? update : create;
  return (
    <Dialog
      title={dept ? t('Abteilung bearbeiten') : t('Abteilung hinzufügen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!name}
            onClick={() => m.mutate(dept ? { name } : { hotelId, name }, { onSuccess: onDone })}
          >
            {t('Speichern')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Name')} htmlFor="dn">
        <input id="dn" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- users and roles
