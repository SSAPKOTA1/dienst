import type {
  HotelDto,
  Items,
  PatternGranularity,
  PatternLevel,
  PatternMetric,
  PatternsDto,
} from '@dienst/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet } from '../lib/api';
import { fnum } from '../lib/format';
import { ErrorNote } from '../components/ui';
import { todayIso } from './planning/util';

type MetricKey = 'sick' | 'overtime' | 'late' | 'longStay';

const PANELS: Array<[MetricKey, string, string]> = [
  ['sick', 'Krankheit', 'Anteil der geplanten Schichten, die wegen Krankheit ausfielen (%)'],
  ['overtime', 'Überstunden', 'Stunden über der geplanten Arbeitszeit (genehmigte Stempelzeiten)'],
  ['late', 'Verspätungen', 'Anteil der Einstempelungen nach Schichtbeginn plus Karenzzeit (%)'],
  ['longStay', 'Lange Anwesenheit', 'Anteil der Ausstempelungen mehr als 30 Minuten nach Schichtende (%)'],
];
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** A small bar chart as inline SVG. A hidden value (group too small) is a short dash, never a bar. */
function Bars({ values, max, label }: { values: Array<number | null>; max: number; label: string }) {
  const w = 8;
  const gap = 3;
  const h = 32;
  const width = values.length * (w + gap);
  return (
    <svg role="img" aria-label={label} width={width} height={h} style={{ display: 'block' }}>
      {values.map((v, i) =>
        v == null ? (
          <line
            key={i}
            x1={i * (w + gap)}
            x2={i * (w + gap) + w}
            y1={h - 1}
            y2={h - 1}
            stroke="currentColor"
            strokeWidth={2}
          />
        ) : (
          <rect
            key={i}
            x={i * (w + gap)}
            y={h - Math.max(1, (v / (max || 1)) * h)}
            width={w}
            height={Math.max(1, (v / (max || 1)) * h)}
            fill="var(--color-accent)"
          >
            <title>{String(v)}</title>
          </rect>
        ),
      )}
    </svg>
  );
}

const shiftMonth = (m: string, n: number) =>
  new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 7);

/**
 * Patterns over time as totals per hotel, department or shift. Never per person; figures from small groups are
 * hidden by the server. Late arrivals and long stays only appear once the company has switched them on.
 */
export function AnalyticsPatterns() {
  const { t } = useTranslation();
  const [level, setLevel] = useState<PatternLevel>('department');
  const [granularity, setGranularity] = useState<PatternGranularity>('month');
  const [months, setMonths] = useState(6);
  const hotels = useGet<Items<HotelDto>>('/hotels');
  const hotelIds = (hotels.data?.items ?? []).map((h) => h.id);
  const thisMonth = todayIso().slice(0, 7);
  const from = `${shiftMonth(thisMonth, -(months - 1))}-01`;
  const to = new Date(Date.UTC(Number(thisMonth.slice(0, 4)), Number(thisMonth.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);
  const q = useGet<PatternsDto>(hotelIds.length ? '/analytics/patterns' : null, {
    hotelIds,
    from,
    to,
    level,
    granularity,
  });
  const d = q.data;
  return (
    <section style={{ padding: 'var(--space-4)' }} aria-labelledby="pat-h" data-testid="patterns">
      <h2 id="pat-h" style={{ margin: '0 0 8px' }}>
        {t('Muster')}
      </h2>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <label>
          {t('Ebene')}{' '}
          <select
            className="input"
            style={{ width: 'auto' }}
            value={level}
            onChange={(e) => setLevel(e.target.value as PatternLevel)}
          >
            <option value="hotel">{t('Hotel')}</option>
            <option value="department">{t('Abteilung')}</option>
            <option value="shift">{t('Schicht')}</option>
          </select>
        </label>
        <label>
          {t('Zeitraum')}{' '}
          <select
            className="input"
            style={{ width: 'auto' }}
            value={granularity}
            onChange={(e) => setGranularity(e.target.value as PatternGranularity)}
          >
            <option value="week">{t('je Woche')}</option>
            <option value="month">{t('je Monat')}</option>
          </select>
        </label>
        <label>
          {t('Rückblick')}{' '}
          <select
            className="input"
            style={{ width: 'auto' }}
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
          >
            <option value={3}>{t('3 Monate')}</option>
            <option value={6}>{t('6 Monate')}</option>
            <option value={12}>{t('12 Monate')}</option>
          </select>
        </label>
      </div>
      <div style={{ fontSize: 12, marginBottom: 12 }}>
        {t(
          'Nur Summen, nie einzelne Personen. Zahlen aus weniger als 5 Personen werden nicht gezeigt (Krankheit: 10).',
        )}
      </div>
      <ErrorNote error={q.error} />
      {d &&
        PANELS.map(([key, title, hint]) => {
          const metrics = d.groups.map((g) => ({ g, m: g.metrics[key] as PatternMetric | null }));
          const available = metrics.some((x) => x.m);
          const max = Math.max(
            0,
            ...metrics.flatMap((x) =>
              (x.m ? [...x.m.values, ...x.m.byWeekday] : []).filter((v): v is number => v != null),
            ),
          );
          return (
            <div key={key} style={{ marginBottom: 20 }} data-testid={`pattern-${key}`}>
              <h3 style={{ margin: '0 0 2px' }}>{t(title)}</h3>
              <div style={{ fontSize: 12, marginBottom: 6 }}>{t(hint)}</div>
              {!available ? (
                <div style={{ fontSize: 13 }} data-testid={`pattern-${key}-off`}>
                  {d.groups.length === 0
                    ? t('Keine Daten im Zeitraum.')
                    : t('Nicht freigeschaltet. Einschalten unter Einrichtung → Regeln → Funktionen.')}
                </div>
              ) : (
                <table className="table" style={{ border: '2px solid var(--color-text)' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left' }}>{t('Gruppe')}</th>
                      <th>{t('Verlauf')}</th>
                      <th>{t('Wochentage')}</th>
                      <th>{t('Gesamt')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.map(({ g, m }) => (
                      <tr key={g.key}>
                        <td>
                          <b>{g.name}</b>
                          {level !== 'hotel' && <div style={{ fontSize: 11 }}>{g.hotelName}</div>}
                        </td>
                        {m ? (
                          <>
                            <td>
                              <Bars
                                values={m.values}
                                max={max}
                                label={`${g.name}: ${t(title)}, ${d.periods.join(', ')}`}
                              />
                            </td>
                            <td>
                              <Bars
                                values={m.byWeekday}
                                max={max}
                                label={`${g.name}: ${t(title)}, ${WEEKDAYS.map((w) => t(w)).join(', ')}`}
                              />
                            </td>
                            <td data-testid={`pattern-${key}-total`}>
                              {m.total == null ? '–' : `${fnum(m.total)} ${m.unit === 'hours' ? 'h' : '%'}`}
                            </td>
                          </>
                        ) : (
                          <td colSpan={3}>{t('Nicht freigeschaltet.')}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {available && (
                <details style={{ marginTop: 4 }}>
                  <summary>{t('Werte als Tabelle')}</summary>
                  <table className="table" style={{ fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left' }}>{t('Gruppe')}</th>
                        {d.periods.map((p) => (
                          <th key={p}>{p}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {metrics
                        .filter((x) => x.m)
                        .map(({ g, m }) => (
                          <tr key={g.key}>
                            <td>{g.name}</td>
                            {m!.values.map((v, i) => (
                              <td key={i}>{v == null ? '–' : fnum(v)}</td>
                            ))}
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </details>
              )}
            </div>
          );
        })}
    </section>
  );
}
