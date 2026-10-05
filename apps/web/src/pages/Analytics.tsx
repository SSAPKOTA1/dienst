import type { AnalyticsSummaryDto } from '@dienst/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet } from '../lib/api';
import { fnum, fsigned } from '../lib/format';
import { PageHead } from '../components/ui';
import { todayIso } from './planning/util';

const monthRange = (m: string) =>
  [
    `${m}-01`,
    new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10),
  ] as const;

/** Aggregated figures only: no per-person rankings; absence rates need at least five employees. */
export function Analytics() {
  const { t } = useTranslation();
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [from, to] = monthRange(month);
  const a = useGet<AnalyticsSummaryDto>('/analytics/summary', { from, to });
  const d = a.data;
  const card = (label: string, value: React.ReactNode, id: string) => (
    <div
      style={{ padding: 'var(--space-3) var(--space-4)', borderRight: '1px solid var(--color-divider)' }}
      data-testid={id}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: 'var(--color-neutral-700)',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 32, fontWeight: 800 }}>{value}</div>
    </div>
  );
  return (
    <main style={{ flex: 1, minWidth: 0 }}>
      <PageHead kicker={t('Team')} title={t('Auswertung')}>
        <input
          type="month"
          className="input"
          aria-label={t('Monat')}
          style={{ width: 'auto' }}
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        />
      </PageHead>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))',
          borderTop: '2px solid var(--color-divider)',
          borderBottom: '2px solid var(--color-divider)',
        }}
      >
        {card(t('Offene Freigaben'), d?.approvals.pending ?? '–', 'an-pending')}
        {card(t('Älter als 5 Tage'), d?.approvals.buckets['6+'] ?? '–', 'an-old')}
        {card(t('Regel-Ausnahmen'), d?.overrides ?? '–', 'an-overrides')}
        {card(
          t('Korrekturquote'),
          d?.corrections.rate == null ? '–' : `${fnum(d.corrections.rate)} %`,
          'an-corr',
        )}
        {card(t('Offene Schichtplätze'), d?.openSlots ?? '–', 'an-open')}
      </div>
      <div style={{ padding: 'var(--space-4)', overflowX: 'auto' }}>
        <table className="table" data-testid="an-table" style={{ border: '2px solid var(--color-text)' }}>
          <thead>
            <tr>
              <th>{t('Hotel')}</th>
              <th>{t('Abteilung')}</th>
              <th>{t('Mitarbeitende')}</th>
              <th>{t('Geplant (h)')}</th>
              <th>{t('Tatsächlich (h)')}</th>
              <th>{t('Zeitkonto gesamt')}</th>
              <th>{t('Abwesenheitsquote')}</th>
            </tr>
          </thead>
          <tbody>
            {(d?.departments ?? []).map((x) => (
              <tr key={x.departmentId}>
                <td>{x.hotel}</td>
                <td>
                  <b>{x.name}</b>
                </td>
                <td>{x.employees}</td>
                <td>{fnum(x.plannedHours)}</td>
                <td>{fnum(x.actualHours)}</td>
                <td>{x.timeAccountHours == null ? '–' : fsigned(x.timeAccountHours)}</td>
                <td>{x.absenceRate == null ? t('unter 5 Personen') : `${fnum(x.absenceRate)} %`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ fontSize: 12, marginTop: 8 }}>
          {t(
            'Es gibt keine Rangliste und keine Bewertung einzelner Personen. Abwesenheitsquoten werden erst ab 5 Personen je Abteilung gezeigt.',
          )}
        </div>
      </div>
    </main>
  );
}
