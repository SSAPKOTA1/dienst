import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useGet } from '../lib/api';
import { fdate, fnum } from '../lib/format';
import { PageHead } from '../components/ui';
import { DOW, dowOf, mondayOfIso, todayIso } from './planning/util';

const ABS_CODE: Record<string, string> = {
  annual_leave: 'U',
  sick_leave: 'K',
  off_day: 'F',
  unpaid_leave: 'UF',
  vocational_school: 'S',
  comp_time: 'ZA',
  special_leave: 'SU',
  training: 'FB',
};
const shiftMonth = (m: string, n: number) =>
  new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 7);

/** Read-only month range overview of the plan (design: "Monatsübersicht"); editing stays in the week view. */
export function MonthOverview() {
  const { t } = useTranslation();
  const [month, setMonth] = useState(() => todayIso().slice(0, 7));
  const hotels = useGet('/hotels');
  const hotelIds = (hotels.data?.items ?? []).map((h: any) => h.id);
  const grid = useGet(hotelIds.length ? '/schedule/grid' : null, {
    hotelIds,
    view: 'employee',
    range: 'month',
    from: `${month}-01`,
  });
  const g = grid.data;
  const days: Array<{ date: string }> = g?.days ?? [];
  return (
    <main style={{ flex: 1, minWidth: 0 }}>
      <PageHead kicker={t('Planung')} title={t('Monatsübersicht')}>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button
            className="btn btn-secondary"
            aria-label={t('Vorheriger Monat')}
            onClick={() => setMonth(shiftMonth(month, -1))}
          >
            ←
          </button>
          <b style={{ minWidth: 150, textAlign: 'center' }} data-testid="month-label">
            {fdate(`${month}-01`, { month: 'long', year: 'numeric' })}
          </b>
          <button
            className="btn btn-secondary"
            aria-label={t('Nächster Monat')}
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            →
          </button>
        </div>
      </PageHead>
      <div style={{ overflowX: 'auto', padding: '0 var(--space-4) var(--space-4)' }}>
        <table className="table" style={{ minWidth: 900, fontSize: 12 }} data-testid="month-table">
          <thead>
            <tr>
              <th style={{ position: 'sticky', left: 0, background: 'var(--color-bg)' }}>
                {t('Mitarbeiter')}
              </th>
              {days.map((d) => (
                <th
                  key={d.date}
                  style={{
                    textAlign: 'center',
                    padding: '4px 2px',
                    background: dowOf(d.date) >= 5 ? 'var(--color-neutral-200)' : undefined,
                  }}
                >
                  <div>{t(DOW[dowOf(d.date)]!)}</div>
                  <div>{Number(d.date.slice(8, 10))}</div>
                </th>
              ))}
              <th>{t('Std.')}</th>
            </tr>
          </thead>
          <tbody>
            {(g?.rows ?? []).map((r: any) => (
              <tr key={r.key}>
                <td
                  style={{
                    position: 'sticky',
                    left: 0,
                    background: 'var(--color-bg)',
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {r.label}
                </td>
                {r.cells.map((c: any) => {
                  const e = c.entries.filter((x: any) => !x.isOtherHotel);
                  const abs = (g.absences as any[]).find(
                    (a) => a.employeeId === r.employeeId && a.from <= c.date && a.to >= c.date,
                  );
                  return (
                    <td
                      key={c.date}
                      title={e
                        .map(
                          (x: any) => `${x.shiftName ?? ''} ${x.start.slice(11, 16)}–${x.end.slice(11, 16)}`,
                        )
                        .join(', ')}
                      style={{
                        textAlign: 'center',
                        padding: '4px 2px',
                        background: abs
                          ? 'var(--color-neutral-200)'
                          : e.length
                            ? 'var(--color-accent-100, #fde6e1)'
                            : undefined,
                        fontWeight: 700,
                      }}
                    >
                      {e.length
                        ? e.map((x: any) => (x.shiftName ?? '•').charAt(0)).join('')
                        : abs
                          ? (ABS_CODE[abs.type] ?? '–')
                          : ''}
                    </td>
                  );
                })}
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fnum(r.totalHours)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ fontSize: 12, marginTop: 8 }}>
          {t('Früh/Spät/Nacht = erster Buchstabe der Schicht; U Urlaub, K krank, F frei, S Berufsschule.')}{' '}
          <Link to={`/planning?week=${mondayOfIso(`${month}-01`)}`}>{t('Zur Wochenansicht')}</Link>
        </div>
      </div>
    </main>
  );
}
