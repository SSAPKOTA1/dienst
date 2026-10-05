import type { DepartmentDto, HotelDto, Items, OpenShiftWithClaimsDto, ShiftDto } from '@dienst/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../lib/api';
import { fdate, ftime } from '../lib/format';
import { Dialog, ErrorNote, Field, PageHead, useToast } from '../components/ui';
import { todayIso } from './planning/util';

const TZ = 'Europe/Berlin';

/** Open slots the planners publish to eligible staff (SPEC backlog: open shifts). */
export function OpenShifts() {
  const { t } = useTranslation();
  const toast = useToast();
  const list = useGet<Items<OpenShiftWithClaimsDto>>('/open-shifts', { status: 'open' });
  const hotels = useGet<Items<HotelDto>>('/hotels');
  const depts = useGet<Items<DepartmentDto>>('/departments');
  const shifts = useGet<Items<ShiftDto>>('/shifts');
  const [dlg, setDlg] = useState(false);
  const cancel = useSend<number>('DELETE', (id) => `/open-shifts/${id}`);
  const hn = (id: number) => (hotels.data?.items ?? []).find((h) => h.id === id)?.name ?? id;
  const dn = (id: number) => (depts.data?.items ?? []).find((d) => d.id === id)?.name ?? id;
  return (
    <main style={{ flex: 1, minWidth: 0 }}>
      <PageHead kicker={t('Planung')} title={t('Offene Schichten')}>
        <button className="btn btn-primary" onClick={() => setDlg(true)} data-testid="open-new">
          {t('Offene Schicht anlegen')}
        </button>
      </PageHead>
      <div style={{ padding: '0 var(--space-4) var(--space-4)' }}>
        <div style={{ border: '2px solid var(--color-text)' }}>
          {(list.data?.items ?? []).length === 0 && (
            <div style={{ padding: 'var(--space-3)' }}>{t('Keine offenen Schichten.')}</div>
          )}
          {(list.data?.items ?? []).map((o) => (
            <div
              key={o.id}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0,1fr) auto',
                gap: 8,
                padding: 'var(--space-2) var(--space-3)',
                borderBottom: '1px solid var(--color-divider)',
                alignItems: 'center',
              }}
              data-testid="open-row"
            >
              <div>
                <b>
                  {fdate(o.date, { weekday: 'short', day: '2-digit', month: '2-digit' })} {ftime(o.start, TZ)}
                  –{ftime(o.end, TZ)}
                </b>{' '}
                <span style={{ fontSize: 13 }}>
                  {hn(o.hotelId)} · {dn(o.departmentId)}
                </span>
                <div style={{ fontSize: 12 }}>
                  {o.claims.length
                    ? `${o.claims.length} ${t('Bewerbungen')}: ${o.claims.map((c) => c.displayName).join(', ')}`
                    : t('Noch keine Bewerbungen.')}
                </div>
              </div>
              <button
                className="btn btn-secondary"
                onClick={() =>
                  cancel.mutate(o.id, {
                    onSuccess: () => {
                      toast(t('Entfernt'));
                      void list.refetch();
                    },
                  })
                }
              >
                {t('Entfernen')}
              </button>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, marginTop: 8 }}>{t('Bewerbungen werden unter Anträge entschieden.')}</div>
      </div>
      {dlg && (
        <OpenDialog
          hotels={hotels.data?.items ?? []}
          depts={depts.data?.items ?? []}
          shifts={shifts.data?.items ?? []}
          onClose={() => setDlg(false)}
          onDone={() => {
            setDlg(false);
            void list.refetch();
          }}
        />
      )}
    </main>
  );
}

function OpenDialog({
  hotels,
  depts,
  shifts,
  onClose,
  onDone,
}: {
  hotels: HotelDto[];
  depts: DepartmentDto[];
  shifts: ShiftDto[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [hotelId, setHotelId] = useState(String(hotels[0]?.id ?? ''));
  const [departmentId, setDepartmentId] = useState('');
  const [shiftId, setShiftId] = useState('');
  const [date, setDate] = useState(todayIso());
  const dd = depts.filter((d) => String(d.hotelId) === hotelId);
  const dept = departmentId || String(dd[0]?.id ?? '');
  const ss = shifts.filter((s) => String(s.departmentId) === dept);
  const m = useSend('POST', '/open-shifts');
  return (
    <Dialog
      title={t('Offene Schicht anlegen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={m.isPending || !(shiftId || ss[0])}
            data-testid="open-save"
            onClick={() =>
              m.mutate(
                {
                  hotelId: Number(hotelId),
                  departmentId: Number(dept),
                  shiftId: Number(shiftId || ss[0]?.id),
                  date,
                },
                { onSuccess: onDone },
              )
            }
          >
            {t('Veröffentlichen')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Hotel')} htmlFor="os-h">
        <select
          id="os-h"
          className="input"
          value={hotelId}
          onChange={(e) => {
            setHotelId(e.target.value);
            setDepartmentId('');
            setShiftId('');
          }}
        >
          {hotels.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('Abteilung')} htmlFor="os-d">
        <select
          id="os-d"
          className="input"
          value={dept}
          onChange={(e) => {
            setDepartmentId(e.target.value);
            setShiftId('');
          }}
        >
          {dd.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('Schicht')} htmlFor="os-s">
        <select
          id="os-s"
          className="input"
          value={shiftId || String(ss[0]?.id ?? '')}
          onChange={(e) => setShiftId(e.target.value)}
        >
          {ss.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} {s.startTime}–{s.endTime}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('Datum')} htmlFor="os-date">
        <input
          id="os-date"
          type="date"
          className="input"
          value={date}
          min={todayIso()}
          onChange={(e) => setDate(e.target.value)}
        />
      </Field>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}
