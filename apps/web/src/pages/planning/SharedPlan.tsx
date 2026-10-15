import type { SharedPlanDto } from '@dienst/shared';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useGet } from '../../lib/api';
import { ErrorNote } from '../../components/ui';
import { dayNum, isoWeekNo, rangeLabel } from './util';

const DOW = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const dowOf = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay();

/**
 * The Dienstplan as a clean copy for employees. Everything on it comes from /schedule/shared, which sends only
 * published shifts, full names and a neutral "abwesend": no warnings, drafts, wishes, hours or reasons.
 */
export function SharedPlan() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const hotelIds = (params.get('hotelIds') ?? '')
    .split(',')
    .map(Number)
    .filter((n) => n > 0);
  const from = params.get('from') ?? '';
  const q = useGet<SharedPlanDto>(
    '/schedule/shared',
    { hotelIds, from },
    { enabled: hotelIds.length > 0 && !!from },
  );
  const err = q.error as { details?: { reason?: string } } | null;
  const back = <Link to="/planning">← {t('Zurück zum Dienstplan')}</Link>;

  if (q.isError)
    return (
      <main
        style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 12 }}
        data-noprint
      >
        {back}
        {err?.details?.reason === 'NOT_PUBLISHED' ? (
          <div role="alert" data-testid="share-not-published">
            {t('Die Woche ist noch nicht vollständig veröffentlicht. Bitte zuerst veröffentlichen.')}
          </div>
        ) : (
          <ErrorNote error={q.error} />
        )}
      </main>
    );
  const d = q.data;
  if (!d) return <main style={{ padding: 'var(--space-4)' }}>{t('Lädt …')}</main>;
  return (
    <main style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div data-noprint style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        {back}
        <button className="btn btn-primary" onClick={() => window.print()} data-testid="share-print">
          {t('Drucken')}
        </button>
      </div>
      <h1 style={{ margin: 0 }}>
        {t('Dienstplan')} · KW {isoWeekNo(d.from)} · {dayNum(d.from)}.{d.from.slice(5, 7)}.–{dayNum(d.to)}.
        {d.to.slice(5, 7)}.{d.to.slice(0, 4)}
      </h1>
      {d.hotels.map((h) => (
        <section key={h.id} aria-label={h.name} style={{ breakInside: 'avoid' }}>
          <h2 style={{ margin: '0 0 8px' }}>{h.name}</h2>
          {h.departments.map((dep) => (
            <table
              key={dep.id}
              className="table"
              data-testid="share-table"
              style={{ border: '2px solid var(--color-text)', marginBottom: 16, width: '100%' }}
            >
              <caption style={{ textAlign: 'left', fontWeight: 700, padding: '4px 0' }}>{dep.name}</caption>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>{t('Name')}</th>
                  {d.days.map((day) => (
                    <th key={day.date}>
                      {t(DOW[dowOf(day.date)]!)} {dayNum(day.date)}.{day.date.slice(5, 7)}.
                      {day.holiday && <div style={{ fontWeight: 400, fontSize: 11 }}>{day.holiday}</div>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dep.employees.map((e) => (
                  <tr key={e.name}>
                    <td>
                      <b>{e.name}</b>
                    </td>
                    {d.days.map((day) => {
                      const c = e.cells.find((x) => x.date === day.date);
                      return (
                        <td key={day.date} style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
                          {c?.entries.map((x) => (
                            <div key={x.start}>
                              {rangeLabel(x.start, x.end)}
                              {x.shiftName ? ` ${x.shiftName}` : ''}
                            </div>
                          ))}
                          {c?.absent && <div>{t('abwesend')}</div>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </section>
      ))}
      {d.hotels.length === 0 && <div>{t('Keine Einträge in dieser Woche.')}</div>}
    </main>
  );
}
