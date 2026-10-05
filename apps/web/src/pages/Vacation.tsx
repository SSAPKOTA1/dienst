import type {
  BlackoutDto,
  DepartmentDto,
  HotelDto,
  Items,
  VacationNoticeList,
  VacationOverviewDto,
  ViolationDto,
  WishList,
  WishListItemDto,
} from '@dienst/shared';
import { useState } from 'react';
import { NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, useGet, useSend, type ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fdate, fnum } from '../lib/format';
import { Dialog, ErrorNote, Field, PageHead, Segmented, useToast } from '../components/ui';
import { todayIso } from './planning/util';

const TABS = [
  ['overview', 'Übersicht'],
  ['blackouts', 'Sperrzeiten'],
  ['wishes', 'Wünsche'],
  ['notices', 'Hinweise'],
] as const;

export function VacationLayout() {
  const { t } = useTranslation();
  return (
    <main style={{ flex: 1, minWidth: 0 }}>
      <PageHead kicker={t('Planung')} title={t('Urlaub')} />
      <nav
        aria-label={t('Urlaub')}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          borderTop: '2px solid var(--color-divider)',
          borderBottom: '2px solid var(--color-divider)',
        }}
      >
        {TABS.map(([k, l]) => (
          <NavLink
            key={k}
            to={`/vacation/${k}`}
            style={({ isActive }) => ({
              fontSize: 14,
              fontWeight: 700,
              padding: '11px 18px',
              borderRight: '1px solid var(--color-divider)',
              textDecoration: 'none',
              background: isActive ? 'var(--color-text)' : 'transparent',
              color: isActive ? 'var(--color-bg)' : 'var(--color-text)',
            })}
          >
            {t(l)}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </main>
  );
}

export function VacationRoutes() {
  return (
    <Routes>
      <Route element={<VacationLayout />}>
        <Route index element={<Navigate to="overview" replace />} />
        <Route path="overview" element={<VacationOverview />} />
        <Route path="blackouts" element={<Blackouts />} />
        <Route path="wishes" element={<Wishes />} />
        <Route path="notices" element={<Notices />} />
      </Route>
    </Routes>
  );
}

const wrap: React.CSSProperties = {
  padding: 'var(--space-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
};
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

// ---------------------------------------------------------------- overview + manual entry
function VacationOverview() {
  const { t } = useTranslation();
  const toast = useToast();
  const [year, setYear] = useState(Number(todayIso().slice(0, 4)));
  const ov = useGet<VacationOverviewDto>('/vacation/overview', { year });
  const [dlg, setDlg] = useState<{ employeeId?: number } | null>(null);
  const [view, setView] = useState<'table' | 'year'>('table');
  return (
    <div style={wrap}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="btn btn-secondary"
          aria-label={t('Vorheriges Jahr')}
          onClick={() => setYear(year - 1)}
        >
          ←
        </button>
        <b data-testid="vac-year" style={{ minWidth: 60, textAlign: 'center' }}>
          {year}
        </b>
        <button
          className="btn btn-secondary"
          aria-label={t('Nächstes Jahr')}
          onClick={() => setYear(year + 1)}
        >
          →
        </button>
        <Segmented
          value={view}
          onChange={setView}
          label={t('Ansicht')}
          options={[
            { value: 'table', label: t('Tabelle') },
            { value: 'year', label: t('Jahresübersicht') },
          ]}
        />
        <button
          className="btn btn-primary"
          style={{ marginLeft: 'auto' }}
          onClick={() => setDlg({})}
          data-testid="vac-entry"
        >
          {t('Urlaub eintragen')}
        </button>
      </div>
      <div style={{ overflowX: 'auto', border: '2px solid var(--color-text)' }}>
        <table className="table" style={{ minWidth: 820 }} data-testid="vac-table">
          <thead>
            <tr>
              <th style={{ paddingLeft: 'var(--space-4)' }}>{t('Mitarbeiter')}</th>
              {view === 'table' ? (
                <>
                  <th>{t('Anspruch')}</th>
                  <th>{t('Übertrag')}</th>
                  <th>{t('Genommen')}</th>
                  <th>{t('Geplant')}</th>
                  <th>{t('Beantragt')}</th>
                  <th>{t('Rest')}</th>
                </>
              ) : (
                MONTHS.map((m) => (
                  <th key={m} style={{ textAlign: 'center' }}>
                    {t(m)}
                  </th>
                ))
              )}
              <th />
            </tr>
          </thead>
          <tbody>
            {(ov.data?.employees ?? []).map((e) => (
              <tr key={e.employeeId} data-testid="vac-row">
                <td style={{ paddingLeft: 'var(--space-4)' }}>
                  <b>{e.displayName}</b>
                  <div style={{ fontSize: 11, color: 'var(--color-neutral-700)' }}>{e.departmentName}</div>
                </td>
                {view === 'table' ? (
                  <>
                    <td>{fnum(e.entitlement)}</td>
                    <td
                      title={
                        e.carryoverExpiresOn ? `${t('verfällt')} ${fdate(e.carryoverExpiresOn)}` : undefined
                      }
                    >
                      {fnum(e.carryover)}
                    </td>
                    <td>{fnum(e.taken)}</td>
                    <td>{fnum(e.planned)}</td>
                    <td>{e.requested ? <b>{fnum(e.requested)}</b> : 0}</td>
                    <td>
                      <b>{fnum(e.remaining)}</b>
                    </td>
                  </>
                ) : (
                  e.months.map((n: number, i: number) => (
                    <td
                      key={i}
                      style={{ textAlign: 'center', background: n ? 'var(--color-neutral-200)' : undefined }}
                    >
                      {n ? fnum(n) : ''}
                    </td>
                  ))
                )}
                <td style={{ textAlign: 'right', paddingRight: 'var(--space-3)' }}>
                  <button className="btn btn-ghost" onClick={() => setDlg({ employeeId: e.employeeId })}>
                    {t('Eintragen')}
                  </button>
                </td>
              </tr>
            ))}
            {(ov.data?.employees ?? []).length === 0 && (
              <tr>
                <td colSpan={9} style={{ paddingLeft: 'var(--space-4)' }}>
                  {t('Keine Mitarbeitenden.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {dlg && (
        <EntryDialog
          employees={ov.data?.employees ?? []}
          employeeId={dlg.employeeId}
          onClose={() => setDlg(null)}
          onDone={() => {
            setDlg(null);
            toast(t('Gespeichert.'));
            void ov.refetch();
          }}
        />
      )}
    </div>
  );
}

function EntryDialog({
  employees,
  employeeId,
  onClose,
  onDone,
}: {
  employees: VacationOverviewDto['employees'];
  employeeId?: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [emp, setEmp] = useState(String(employeeId ?? employees[0]?.employeeId ?? ''));
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [half, setHalf] = useState<'' | 'morning' | 'afternoon'>('');
  const [reason, setReason] = useState('');
  const [needReason, setNeedReason] = useState<ViolationDto[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const submit = async () => {
    setErr(null);
    try {
      await api('/schedule/absence', {
        method: 'POST',
        body: {
          employeeId: Number(emp),
          from,
          to: half ? from : to,
          type: 'annual_leave',
          halfDay: half || undefined,
          overrideReason: needReason ? reason : undefined,
        },
      });
      onDone();
    } catch (e) {
      const ex = e as ApiError;
      if (ex.code === 'REASON_REQUIRED' && ex.details?.violations)
        setNeedReason(ex.details.violations as ViolationDto[]);
      else setErr(e);
    }
  };
  return (
    <Dialog
      title={t('Urlaub eintragen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={!emp || (!!needReason && reason.trim().length < 5)}
          >
            {t('Speichern')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Mitarbeiter')} htmlFor="ve-emp">
        <select id="ve-emp" className="input" value={emp} onChange={(e) => setEmp(e.target.value)}>
          {employees.map((e) => (
            <option key={e.employeeId} value={e.employeeId}>
              {e.displayName}
            </option>
          ))}
        </select>
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label={t('Von')} htmlFor="ve-from">
          <input
            id="ve-from"
            type="date"
            className="input"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              if (to < e.target.value) setTo(e.target.value);
            }}
          />
        </Field>
        <Field label={t('Bis')} htmlFor="ve-to">
          <input
            id="ve-to"
            type="date"
            className="input"
            value={half ? from : to}
            disabled={!!half}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
      </div>
      <Field label={t('Halber Tag')} htmlFor="ve-half">
        <select
          id="ve-half"
          className="input"
          value={half}
          onChange={(e) => setHalf(e.target.value as typeof half)}
        >
          <option value="">{t('Ganze Tage')}</option>
          <option value="morning">{t('Vormittag')}</option>
          <option value="afternoon">{t('Nachmittag')}</option>
        </select>
      </Field>
      {needReason && (
        <div
          role="alert"
          style={{ border: '2px solid var(--color-text)', padding: 'var(--space-2)', fontSize: 13 }}
        >
          <b>
            {t(
              'Das widerspricht einer Sperrzeit oder dem Limit gleichzeitiger Abwesenheiten. Begründung nötig:',
            )}
          </b>
          <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
            {needReason.map((v, i) => (
              <li key={i}>
                {v.code}
                {v.details?.reason ? ` · ${v.details.reason}` : ''}
              </li>
            ))}
          </ul>
          <Field label={t('Begründung (wird protokolliert)')} htmlFor="ve-reason">
            <input
              id="ve-reason"
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
            />
          </Field>
        </div>
      )}
      <ErrorNote error={err} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- blackout periods
function Blackouts() {
  const { t } = useTranslation();
  const hotels = useGet<Items<HotelDto>>('/hotels');
  const depts = useGet<Items<DepartmentDto>>('/departments');
  const list = useGet<Items<BlackoutDto>>('/blackouts');
  const [dlg, setDlg] = useState<Partial<BlackoutDto> | null>(null);
  const del = useSend<number>('DELETE', (id) => `/blackouts/${id}`);
  const hn = (id: number) => (hotels.data?.items ?? []).find((h) => h.id === id)?.name ?? id;
  const dn = (id: number | null) =>
    id ? ((depts.data?.items ?? []).find((d) => d.id === id)?.name ?? id) : t('Alle Abteilungen');
  return (
    <div style={wrap}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 20, marginRight: 'auto' }}>{t('Sperrzeiten für Urlaub')}</h2>
        <button className="btn btn-primary" onClick={() => setDlg({})} data-testid="blackout-new">
          {t('Sperrzeit anlegen')}
        </button>
      </div>
      <div style={{ overflowX: 'auto', border: '2px solid var(--color-text)' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ paddingLeft: 'var(--space-4)' }}>{t('Zeitraum')}</th>
              <th>{t('Hotel')}</th>
              <th>{t('Abteilung')}</th>
              <th>{t('Regel')}</th>
              <th>{t('Grund')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(list.data?.items ?? []).map((b) => (
              <tr key={b.id} data-testid="blackout-row">
                <td style={{ paddingLeft: 'var(--space-4)' }}>
                  {fdate(b.from)} – {fdate(b.to)}
                </td>
                <td>{hn(b.hotelId)}</td>
                <td>{dn(b.departmentId)}</td>
                <td>
                  {b.maxConcurrentAbsent == null
                    ? t('Kein Urlaub')
                    : `${t('höchstens')} ${b.maxConcurrentAbsent} ${t('gleichzeitig abwesend')}`}
                </td>
                <td>{b.reason}</td>
                <td style={{ textAlign: 'right', paddingRight: 'var(--space-3)', whiteSpace: 'nowrap' }}>
                  <button className="btn btn-ghost" onClick={() => setDlg(b)}>
                    {t('Bearbeiten')}
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => del.mutate(b.id, { onSuccess: () => void list.refetch() })}
                  >
                    {t('Löschen')}
                  </button>
                </td>
              </tr>
            ))}
            {(list.data?.items ?? []).length === 0 && (
              <tr>
                <td colSpan={6} style={{ paddingLeft: 'var(--space-4)' }}>
                  {t('Keine Sperrzeiten.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {dlg && (
        <BlackoutDialog
          blackout={dlg}
          hotels={hotels.data?.items ?? []}
          depts={depts.data?.items ?? []}
          onClose={() => setDlg(null)}
          onDone={() => {
            setDlg(null);
            void list.refetch();
          }}
        />
      )}
    </div>
  );
}

function BlackoutDialog({
  blackout,
  hotels,
  depts,
  onClose,
  onDone,
}: {
  blackout: Partial<BlackoutDto>;
  hotels: HotelDto[];
  depts: DepartmentDto[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [hotelId, setHotelId] = useState(String(blackout.hotelId ?? hotels[0]?.id ?? ''));
  const [departmentId, setDepartmentId] = useState(String(blackout.departmentId ?? ''));
  const [from, setFrom] = useState(blackout.from ?? todayIso());
  const [to, setTo] = useState(blackout.to ?? todayIso());
  const [reason, setReason] = useState(blackout.reason ?? '');
  const [mode, setMode] = useState<'none' | 'cap'>(blackout.maxConcurrentAbsent == null ? 'none' : 'cap');
  const [cap, setCap] = useState(String(blackout.maxConcurrentAbsent ?? 1));
  const m = useSend(blackout.id ? 'PUT' : 'POST', blackout.id ? `/blackouts/${blackout.id}` : '/blackouts');
  return (
    <Dialog
      title={blackout.id ? t('Sperrzeit bearbeiten') : t('Sperrzeit anlegen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={m.isPending}
            onClick={() =>
              m.mutate(
                {
                  hotelId: Number(hotelId),
                  departmentId: departmentId ? Number(departmentId) : null,
                  from,
                  to,
                  reason: reason || null,
                  maxConcurrentAbsent: mode === 'none' ? null : Number(cap),
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
      <Field label={t('Hotel')} htmlFor="bo-hotel">
        <select
          id="bo-hotel"
          className="input"
          value={hotelId}
          onChange={(e) => {
            setHotelId(e.target.value);
            setDepartmentId('');
          }}
        >
          {hotels.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('Abteilung')} htmlFor="bo-dept">
        <select
          id="bo-dept"
          className="input"
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
        >
          <option value="">{t('Alle Abteilungen')}</option>
          {depts
            .filter((d) => String(d.hotelId) === hotelId)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
        </select>
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label={t('Von')} htmlFor="bo-from">
          <input
            id="bo-from"
            type="date"
            className="input"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label={t('Bis')} htmlFor="bo-to">
          <input
            id="bo-to"
            type="date"
            className="input"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
      </div>
      <Field label={t('Regel')} htmlFor="bo-mode">
        <select
          id="bo-mode"
          className="input"
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
        >
          <option value="none">{t('Kein Urlaub')}</option>
          <option value="cap">{t('Begrenzt gleichzeitig Abwesende')}</option>
        </select>
      </Field>
      {mode === 'cap' && (
        <Field label={t('Höchstens gleichzeitig abwesend')} htmlFor="bo-cap">
          <input
            id="bo-cap"
            type="number"
            min={0}
            className="input"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
        </Field>
      )}
      <Field label={t('Grund')} htmlFor="bo-reason">
        <input
          id="bo-reason"
          className="input"
          value={reason}
          maxLength={200}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- wishes
function Wishes() {
  const { t } = useTranslation();
  const [type, setType] = useState<'leave' | 'shift'>('leave');
  const [status, setStatus] = useState('pending');
  const list = useGet<WishList>('/wishes', { type, status: status || undefined });
  const [rej, setRej] = useState<WishListItemDto | null>(null);
  const decide = useSend<{ type: string; id: number } & Record<string, unknown>>(
    'PUT',
    (b) => `/wishes/${b.type}/${b.id}`,
  );
  const prio = (p: number) => [t('hoch'), t('mittel'), t('niedrig')][p - 1];
  const done = () => {
    setRej(null);
    void list.refetch();
  };
  return (
    <div style={wrap}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Segmented
          value={type}
          onChange={setType}
          label={t('Art')}
          options={[
            { value: 'leave', label: t('Urlaubswünsche') },
            { value: 'shift', label: t('Schichtwünsche') },
          ]}
        />
        <Segmented
          value={status}
          onChange={setStatus}
          label={t('Status')}
          options={[
            { value: 'pending', label: t('Offen') },
            { value: 'granted', label: t('Erfüllt') },
            { value: 'declined', label: t('Abgelehnt') },
          ]}
        />
      </div>
      <div style={{ border: '2px solid var(--color-text)' }}>
        {(list.data?.items ?? []).length === 0 && (
          <div style={{ padding: 'var(--space-3)' }}>{t('Keine Wünsche.')}</div>
        )}
        {(list.data?.items ?? []).map((w) => (
          <div
            key={`${w.type}${w.id}`}
            data-testid="wish-row"
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1fr) auto',
              gap: 8,
              padding: 'var(--space-2) var(--space-3)',
              borderBottom: '1px solid var(--color-divider)',
              alignItems: 'center',
            }}
          >
            <div>
              <b>{w.displayName}</b>{' '}
              {w.type === 'leave'
                ? `${fdate(w.from)} – ${fdate(w.to)} · ${w.days} ${t('Tage')}`
                : `${fdate(w.date)} · ${w.shiftName}`}
              <span className="tag tag-neutral" style={{ marginLeft: 8 }}>
                {t('Priorität')} {prio(w.priority)}
              </span>
              {w.reason && <div style={{ fontSize: 12 }}>„{w.reason}“</div>}
              {w.decisionNote && <div style={{ fontSize: 12 }}>→ {w.decisionNote}</div>}
            </div>
            {w.status === 'pending' && (
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  className="btn btn-primary"
                  onClick={() =>
                    decide.mutate({ type: w.type, id: w.id, decision: 'grant' }, { onSuccess: done })
                  }
                >
                  {t('Erfüllen')}
                </button>
                <button className="btn btn-secondary" onClick={() => setRej(w)}>
                  {t('Ablehnen')}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {rej && <DeclineDialog wish={rej} onClose={() => setRej(null)} onDone={done} />}
    </div>
  );
}

function DeclineDialog({
  wish,
  onClose,
  onDone,
}: {
  wish: WishListItemDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const m = useSend('PUT', `/wishes/${wish.type}/${wish.id}`);
  return (
    <Dialog
      title={t('Wunsch ablehnen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            onClick={() => m.mutate({ decision: 'decline', note: note || undefined }, { onSuccess: onDone })}
          >
            {t('Ablehnen')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Notiz (optional)')} htmlFor="dw-note">
        <input
          id="dw-note"
          className="input"
          value={note}
          maxLength={300}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- notices and carryover
function Notices() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const toast = useToast();
  const [year, setYear] = useState(Number(todayIso().slice(0, 4)));
  const list = useGet<VacationNoticeList>('/vacation/notices', { year });
  const send = useSend<Record<string, unknown>, { sent: number }>('POST', '/vacation/notices/send');
  const carry = useSend<Record<string, unknown>, { carried: number }>('POST', '/vacation/carryover');
  const admin = me?.role !== 'manager';
  return (
    <div style={wrap}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 20, marginRight: 'auto' }}>
          {t('Urlaubshinweise')} {year}
        </h2>
        <select
          className="input"
          style={{ width: 'auto' }}
          aria-label={t('Jahr')}
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        >
          {[year - 1, year, year + 1].map((y) => (
            <option key={y}>{y}</option>
          ))}
        </select>
        {admin &&
          (['initial', 'reminder', 'final'] as const).map((k) => (
            <button
              key={k}
              className="btn btn-secondary"
              onClick={() =>
                send.mutate(
                  { year, kind: k },
                  {
                    onSuccess: (r) => {
                      toast(`${r.sent} ${t('gesendet')}`);
                      void list.refetch();
                    },
                  },
                )
              }
            >
              {k === 'initial'
                ? t('Erster Hinweis senden')
                : k === 'reminder'
                  ? t('Erinnerung senden')
                  : t('Letzte Erinnerung senden')}
            </button>
          ))}
        {admin && (
          <button
            className="btn btn-primary"
            onClick={() =>
              carry.mutate({ year }, { onSuccess: (r) => toast(`${r.carried} ${t('Übertrag gebucht')}`) })
            }
          >
            {t('Resturlaub ins Folgejahr übertragen')}
          </button>
        )}
      </div>
      <div style={{ fontSize: 12 }}>
        {t('Resturlaub verfällt zum 31.3. nur, wenn der Hinweis nachweislich versendet wurde.')}
      </div>
      <div style={{ overflowX: 'auto', border: '2px solid var(--color-text)' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ paddingLeft: 'var(--space-4)' }}>{t('Mitarbeiter')}</th>
              <th>{t('Hinweis')}</th>
              <th>{t('Rest')}</th>
              <th>{t('Gesendet')}</th>
              <th>{t('Bestätigt')}</th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.items ?? []).map((n) => (
              <tr key={n.id}>
                <td style={{ paddingLeft: 'var(--space-4)' }}>{n.displayName}</td>
                <td>
                  {n.kind === 'initial'
                    ? t('Erster Hinweis')
                    : n.kind === 'reminder'
                      ? t('Erinnerung')
                      : t('Letzte Erinnerung')}
                </td>
                <td>{fnum(n.remainingDays)}</td>
                <td>{fdate(n.sentAt)}</td>
                <td>{n.acknowledgedAt ? fdate(n.acknowledgedAt) : '–'}</td>
              </tr>
            ))}
            {(list.data?.items ?? []).length === 0 && (
              <tr>
                <td colSpan={5} style={{ paddingLeft: 'var(--space-4)' }}>
                  {t('Noch keine Hinweise.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ErrorNote error={send.error ?? carry.error} />
    </div>
  );
}
