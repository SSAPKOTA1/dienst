import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet } from '../lib/api';
import { fdate, fnum } from '../lib/format';
import { PageHead, Segmented } from '../components/ui';
import { todayIso } from './planning/util';

const wrap: React.CSSProperties = {
  padding: '0 var(--space-4) var(--space-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
};
const monthRange = (m: string) =>
  [
    `${m}-01`,
    new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10),
  ] as const;

const STATUS: Record<string, string> = { ok: 'erledigt', open: 'offen', overdue: 'überfällig' };
const Status = ({ s }: { s: string }) => {
  const { t } = useTranslation();
  return (
    <span
      className={`tag ${s === 'ok' ? 'tag-accent' : 'tag-neutral'}`}
      style={s === 'overdue' ? { fontWeight: 800, outline: '2px solid var(--color-text)' } : undefined}
    >
      {s === 'overdue' ? '! ' : ''}
      {t(STATUS[s] ?? s)}
    </span>
  );
};

/** Working-time compliance reports (rest-period compensation, replacement rest days, Sundays and night work). */
export function Compliance() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'rest' | 'replacement' | 'sundays'>('rest');
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [from, to] = monthRange(month);
  const rest = useGet(tab === 'rest' ? '/compliance/rest-compensation' : null, { from, to });
  const repl = useGet(tab === 'replacement' ? '/compliance/replacement-rest' : null, { from, to });
  const sun = useGet(tab === 'sundays' ? '/compliance/sundays-nights' : null, {
    year: Number(month.slice(0, 4)),
  });
  const Th = ({ children }: { children?: React.ReactNode }) => <th>{children}</th>;
  return (
    <main style={{ flex: 1, minWidth: 0 }}>
      <PageHead kicker={t('Heute')} title={t('Compliance')}>
        <input
          type="month"
          className="input"
          aria-label={t('Monat')}
          style={{ width: 'auto' }}
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        />
      </PageHead>
      <div style={wrap}>
        <Segmented
          value={tab}
          onChange={setTab}
          label={t('Bericht')}
          options={[
            { value: 'rest', label: t('Ruhezeit-Ausgleich') },
            { value: 'replacement', label: t('Ersatzruhetage') },
            { value: 'sundays', label: t('Sonntage und Nächte') },
          ]}
        />
        <div style={{ overflowX: 'auto', border: '2px solid var(--color-text)' }}>
          {tab === 'rest' && (
            <table className="table" data-testid="compliance-rest">
              <thead>
                <tr>
                  <Th>{t('Mitarbeiter')}</Th>
                  <Th>{t('Verkürzte Ruhezeit')}</Th>
                  <Th>{t('Dauer')}</Th>
                  <Th>{t('Ausgleich bis')}</Th>
                  <Th>{t('Status')}</Th>
                </tr>
              </thead>
              <tbody>
                {(rest.data?.items ?? []).map((r: any, i: number) => (
                  <tr key={i}>
                    <td>{r.displayName}</td>
                    <td>
                      {fdate(r.shortenedFrom)} → {fdate(r.shortenedTo)}
                    </td>
                    <td>{fnum(r.gapMinutes / 60, 1)} h</td>
                    <td>{fdate(r.dueBy)}</td>
                    <td>
                      <Status s={r.status} />
                    </td>
                  </tr>
                ))}
                {(rest.data?.items ?? []).length === 0 && (
                  <tr>
                    <td colSpan={5}>{t('Keine verkürzten Ruhezeiten.')}</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          {tab === 'replacement' && (
            <table className="table" data-testid="compliance-replacement">
              <thead>
                <tr>
                  <Th>{t('Mitarbeiter')}</Th>
                  <Th>{t('Arbeit am')}</Th>
                  <Th>{t('Art')}</Th>
                  <Th>{t('Ersatzruhetag bis')}</Th>
                  <Th>{t('Ersatzruhetag')}</Th>
                  <Th>{t('Status')}</Th>
                </tr>
              </thead>
              <tbody>
                {(repl.data?.items ?? []).map((r: any, i: number) => (
                  <tr key={i}>
                    <td>{r.displayName}</td>
                    <td>{fdate(r.date)}</td>
                    <td>{r.kind === 'sunday' ? t('Sonntag') : t('Feiertag')}</td>
                    <td>{fdate(r.dueBy)}</td>
                    <td>{r.restDayOn ? fdate(r.restDayOn) : '–'}</td>
                    <td>
                      <Status s={r.status} />
                    </td>
                  </tr>
                ))}
                {(repl.data?.items ?? []).length === 0 && (
                  <tr>
                    <td colSpan={6}>{t('Keine Sonntags- oder Feiertagsarbeit.')}</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          {tab === 'sundays' && (
            <table className="table" data-testid="compliance-sundays">
              <thead>
                <tr>
                  <Th>{t('Mitarbeiter')}</Th>
                  <Th>{t('Sonntage gearbeitet')}</Th>
                  <Th>{t('Sonntage frei')}</Th>
                  <Th>{t('Nächte (12 Monate)')}</Th>
                </tr>
              </thead>
              <tbody>
                {(sun.data?.items ?? []).map((r: any) => (
                  <tr key={r.employeeId}>
                    <td>{r.displayName}</td>
                    <td>{r.sundaysWorked}</td>
                    <td style={r.sundaysFree < 15 ? { fontWeight: 800 } : undefined}>
                      {r.sundaysFree}
                      {r.sundaysFree < 15 ? ' !' : ''}
                    </td>
                    <td>
                      {r.nightsLast12Months}
                      {r.nightsLast12Months >= 48 ? ` · ${t('Nachtarbeitnehmer')}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ fontSize: 12 }}>
          {t('Auswertung der geplanten Schichten. Mindestens 15 Sonntage im Jahr müssen frei bleiben.')}
        </div>
      </div>
    </main>
  );
}
