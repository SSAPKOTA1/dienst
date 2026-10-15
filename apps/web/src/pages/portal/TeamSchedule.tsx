import type { TeamScheduleDto } from '@dienst/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet } from '../../lib/api';
import { ftime } from '../../lib/format';
import { addDaysIso, mondayOfIso, todayIso, weekRangeLabel } from '../planning/util';
import { TZ, card, dayLabel, line } from './common';

/** Read-only plan of all colleagues in the employee's hotels: names and times, own rows highlighted. */
export function TeamSchedule() {
  const { t } = useTranslation();
  const [week, setWeek] = useState(() => mondayOfIso(todayIso()));
  const [hotel, setHotel] = useState('');
  const to = addDaysIso(week, 6);
  const s = useGet<TeamScheduleDto>('/me/team-schedule', {
    from: week,
    to,
    ...(hotel ? { hotelId: hotel } : {}),
  });
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(week, i));
  const today = todayIso();
  const hotels = s.data?.hotels ?? [];
  const multi = hotels.length > 1;
  return (
    <div data-testid="team-schedule">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 'var(--space-3)' }}>
        <button
          className="btn btn-secondary"
          aria-label={t('Vorherige Woche')}
          onClick={() => setWeek(addDaysIso(week, -7))}
        >
          ←
        </button>
        <div style={{ flex: 1, textAlign: 'center', fontWeight: 800 }}>{weekRangeLabel(week, to)}</div>
        <button
          className="btn btn-secondary"
          aria-label={t('Nächste Woche')}
          onClick={() => setWeek(addDaysIso(week, 7))}
        >
          →
        </button>
      </div>
      {multi && (
        <div style={{ padding: '0 var(--space-3) var(--space-3)' }}>
          <label htmlFor="ts-hotel" style={{ display: 'block', fontSize: 12 }}>
            {t('Hotel')}
          </label>
          <select id="ts-hotel" className="input" value={hotel} onChange={(e) => setHotel(e.target.value)}>
            <option value="">{t('Alle meine Hotels')}</option>
            {hotels.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <section style={card}>
        {days.map((d) => {
          const entries = (s.data?.entries ?? []).filter((e) => e.date === d);
          const away = (s.data?.absences ?? []).filter((a) => a.from <= d && a.to >= d);
          return (
            <div
              key={d}
              style={{
                ...line,
                display: 'grid',
                gridTemplateColumns: '96px 1fr',
                gap: 8,
                background: d === today ? 'var(--color-surface)' : undefined,
              }}
              data-testid="team-day"
            >
              <b>{dayLabel(d)}</b>
              <div>
                {entries.map((e) => (
                  <div
                    key={e.id}
                    data-testid={e.mine ? 'team-entry-mine' : 'team-entry'}
                    style={
                      e.mine
                        ? { fontWeight: 800, borderLeft: '4px solid currentColor', paddingLeft: 6 }
                        : undefined
                    }
                  >
                    <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                      {ftime(e.start, TZ)}–{ftime(e.end, TZ)}
                    </span>{' '}
                    {e.displayName}
                    {e.mine ? ` (${t('ich')})` : ''}
                    <span style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
                      {e.shiftName ? ` · ${e.shiftName}` : ''}
                      {multi && !hotel ? ` · ${hotels.find((h) => h.id === e.hotelId)?.name ?? ''}` : ''}
                    </span>
                  </div>
                ))}
                {away.map((a) => (
                  <div
                    key={`${a.employeeId}-${a.from}`}
                    style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}
                    data-testid="team-away"
                  >
                    {a.displayName}
                    {a.mine ? ` (${t('ich')})` : ''} · {t('abwesend')}
                  </div>
                ))}
                {!entries.length && !away.length && (
                  <span style={{ color: 'var(--color-neutral-700)' }}>{t('Keine Dienste')}</span>
                )}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
