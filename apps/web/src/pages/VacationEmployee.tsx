import type { VacationOverviewDto } from '@dienst/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../lib/api';
import { fdate, fnum } from '../lib/format';
import { Dialog, ErrorNote, Field, PageHead, useToast } from '../components/ui';
import { todayIso } from './planning/util';

type Row = VacationOverviewDto['employees'][number];
type Entry = Row['entries'][number];
interface DetailDto {
  year: number;
  today: string;
  employee: Row;
}

const wrap: React.CSSProperties = {
  padding: 'var(--space-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};
const cell: React.CSSProperties = { padding: '6px 10px', fontVariantNumeric: 'tabular-nums' };

/** Detail page of one employee's vacation: the figures of the overview row, the months and every entry, with the
 *  actions approve, reject, edit and cancel. All rules are checked by the server. */
export function VacationEmployee() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { id } = useParams();
  const currentYear = Number(todayIso().slice(0, 4));
  // the current year first; earlier years can be selected
  const years = Array.from({ length: 6 }, (_, i) => currentYear - i);
  const [year, setYear] = useState(currentYear);
  const q = useGet<DetailDto>(`/vacation/employees/${id}`, { year });
  const decide = useSend<{ id: number; decision: 'approve' | 'reject' }>(
    'PUT',
    (b) => `/approvals/absences/${b.id}`,
  );
  const cancel = useSend<{ id: number }>('DELETE', (b) => `/schedule/absence/${b.id}`);
  const edit = useSend<{ id: number; type: string; from: string; to: string; halfDay?: string }>(
    'PUT',
    (b) => `/schedule/absence/${b.id}`,
  );
  const [editing, setEditing] = useState<Entry | null>(null);
  const [cancelling, setCancelling] = useState<Entry | null>(null);
  const [draft, setDraft] = useState({ from: '', to: '', halfDay: '' });
  const emp = q.data?.employee;
  const monthName = (m: number) =>
    new Intl.DateTimeFormat(i18n.language, { month: 'short' }).format(new Date(year, m, 1));
  const statusLabel = (s: string) =>
    s === 'pending' ? t('Beantragt') : s === 'approved' ? t('Genehmigt') : t(s);

  if (q.isError)
    return (
      <div style={wrap}>
        <ErrorNote error={q.error} />
      </div>
    );
  if (!emp) return <div style={wrap}>{t('Lädt …')}</div>;

  const rest = (days: number) => (emp.remaining == null ? '–' : fnum(emp.remaining + days));
  return (
    <div style={wrap}>
      <Link to="/vacation/overview">← {t('Zurück zur Übersicht')}</Link>
      <PageHead kicker={t('Urlaub')} title={emp.displayName ?? ''}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {t('Jahr')}
          <select
            className="input"
            style={{ width: 'auto' }}
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </PageHead>
      <div
        data-testid="vd-summary"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 8 }}
      >
        <div>
          {t('Anspruch')}: <b>{emp.entitlement == null ? '–' : fnum(emp.entitlement)}</b>
        </div>
        <div>
          {t('Übertrag')}: <b>{fnum(emp.carryover)}</b>
          {emp.carryoverExpiresOn ? ` (${t('verfällt')} ${fdate(emp.carryoverExpiresOn)})` : ''}
        </div>
        <div>
          {t('Genommen')}: <b>{fnum(emp.taken)}</b>
        </div>
        <div>
          {t('Geplant')}: <b>{fnum(emp.planned)}</b>
        </div>
        <div>
          {t('Beantragt')}: <b>{fnum(emp.requested)}</b>
        </div>
        <div>
          {t('Rest')}: <b>{emp.remaining == null ? '–' : fnum(emp.remaining)}</b>
        </div>
      </div>
      <table className="table" data-testid="vd-months" style={{ border: '2px solid var(--color-text)' }}>
        <thead>
          <tr>
            {Array.from({ length: 12 }, (_, m) => (
              <th key={m} style={cell}>
                {monthName(m)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {emp.months.map((n, m) => (
              <td key={m} style={{ ...cell, textAlign: 'center' }}>
                {n ? fnum(n) : ''}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <ErrorNote error={decide.error ?? cancel.error ?? edit.error} />
      <table className="table" data-testid="vd-entries" style={{ border: '2px solid var(--color-text)' }}>
        <thead>
          <tr>
            <th style={cell}>{t('Von')}</th>
            <th style={cell}>{t('Bis')}</th>
            <th style={cell}>{t('Tage')}</th>
            <th style={cell}>{t('Status')}</th>
            <th style={cell}>{t('Aktionen')}</th>
          </tr>
        </thead>
        <tbody>
          {emp.entries.length === 0 && (
            <tr>
              <td colSpan={5} style={cell}>
                {t('Keine Einträge in diesem Jahr.')}
              </td>
            </tr>
          )}
          {emp.entries.map((x) => (
            <tr key={x.id}>
              <td style={cell}>{fdate(x.from)}</td>
              <td style={cell}>{fdate(x.to)}</td>
              <td style={cell}>
                {fnum(x.days)}
                {x.halfDay ? ` (${t('halber Tag')})` : ''}
              </td>
              <td style={cell}>{statusLabel(x.status)}</td>
              <td style={cell}>
                {x.status === 'pending' && (
                  <>
                    <button
                      className="btn btn-primary"
                      onClick={() => decide.mutate({ id: x.id, decision: 'approve' })}
                    >
                      {t('Genehmigen')}
                    </button>{' '}
                    <button
                      className="btn btn-secondary"
                      onClick={() => decide.mutate({ id: x.id, decision: 'reject' })}
                    >
                      {t('Ablehnen')}
                    </button>
                  </>
                )}
                {x.status === 'approved' && (
                  <>
                    <button
                      className="btn btn-ghost"
                      onClick={() => {
                        setEditing(x);
                        setDraft({ from: x.from, to: x.to, halfDay: '' });
                      }}
                    >
                      {t('Bearbeiten')}
                    </button>{' '}
                    <button className="btn btn-ghost" onClick={() => setCancelling(x)}>
                      {t('Stornieren')}
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <Dialog
          title={`${t('Bearbeiten')}: ${emp.displayName ?? ''}`}
          onClose={() => setEditing(null)}
          actions={
            <>
              <button
                className="btn btn-primary"
                disabled={!draft.from || !draft.to || draft.to < draft.from || edit.isPending}
                onClick={() =>
                  edit.mutate(
                    {
                      id: editing.id,
                      type: 'annual_leave',
                      from: draft.from,
                      to: draft.to,
                      ...(draft.halfDay && draft.from === draft.to ? { halfDay: draft.halfDay } : {}),
                    },
                    {
                      onSuccess: () => {
                        setEditing(null);
                        toast(t('Gespeichert.'));
                      },
                    },
                  )
                }
              >
                {t('Speichern')}
              </button>
              <button className="btn btn-secondary" onClick={() => setEditing(null)}>
                {t('Abbrechen')}
              </button>
            </>
          }
        >
          <ErrorNote error={edit.error} />
          <Field label={t('Von')} htmlFor="vd-from">
            <input
              id="vd-from"
              className="input"
              type="date"
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </Field>
          <Field label={t('Bis')} htmlFor="vd-to">
            <input
              id="vd-to"
              className="input"
              type="date"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </Field>
          <Field label={t('Halber Tag')} htmlFor="vd-half">
            <select
              id="vd-half"
              className="input"
              value={draft.halfDay}
              onChange={(e) => setDraft({ ...draft, halfDay: e.target.value })}
            >
              <option value="">{t('Ganzer Tag')}</option>
              <option value="morning">{t('Vormittag')}</option>
              <option value="afternoon">{t('Nachmittag')}</option>
            </select>
          </Field>
          <div style={{ fontSize: 13 }}>
            {t(
              'Die Prüfung der Regeln erfolgt auf dem Server. Bei einem Fehler bleibt der alte Eintrag bestehen.',
            )}
          </div>
        </Dialog>
      )}

      {cancelling && (
        <Dialog
          title={t('Urlaub stornieren?')}
          onClose={() => setCancelling(null)}
          actions={
            <>
              <button
                className="btn btn-primary"
                disabled={cancel.isPending}
                onClick={() =>
                  cancel.mutate(
                    { id: cancelling.id },
                    {
                      onSuccess: () => {
                        setCancelling(null);
                        toast(t('Storniert.'));
                      },
                    },
                  )
                }
              >
                {t('Stornieren')}
              </button>
              <button className="btn btn-secondary" onClick={() => setCancelling(null)}>
                {t('Abbrechen')}
              </button>
            </>
          }
        >
          <div>
            {fdate(cancelling.from)} – {fdate(cancelling.to)} · {fnum(cancelling.days)} {t('Tage')}
          </div>
          <div>
            {t('Rest')}: {emp.remaining == null ? '–' : fnum(emp.remaining)} → {rest(cancelling.days)}
          </div>
          <ErrorNote error={cancel.error} />
        </Dialog>
      )}
    </div>
  );
}
