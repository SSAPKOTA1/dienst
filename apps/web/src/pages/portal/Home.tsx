import type { MyHomeDto } from '@dienst/shared';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fdate, fnum, fsigned, ftime } from '../../lib/format';
import { WebPunchCard } from '../PortalExtras';
import { NOTE_TEXT, TZ, card, cardHead, dayLabel, line, stat } from './common';

export function PortalHome() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const home = useGet<MyHomeDto>('/me/home');
  const read = useSend<number>('PUT', (id) => `/notifications/${id}/read`, [['api', '/me/home']]);
  const h = home.data;
  const first = me?.displayName?.split(' ')[0] ?? '';
  return (
    <main>
      <div style={{ padding: 'var(--space-3) var(--space-3) 0' }}>
        <div
          style={{
            fontSize: 11,
            letterSpacing: '.1em',
            textTransform: 'uppercase',
            color: 'var(--color-accent-700)',
          }}
        >
          {h ? fdate(h.today, { weekday: 'long', day: 'numeric', month: 'long' }) : ''}
        </div>
        <h1 style={{ margin: '2px 0 0', fontSize: 28 }}>
          {t('Hallo')} {first}
        </h1>
        {h?.clockedIn && (
          <div role="status" style={{ marginTop: 6, fontSize: 13, fontWeight: 700 }}>
            ● {t('Du bist eingestempelt.')}
          </div>
        )}
      </div>
      <WebPunchCard />
      <section style={card} aria-labelledby="h-next">
        <h2 id="h-next" style={cardHead}>
          {t('Nächste Schichten')}
        </h2>
        {(h?.nextShifts ?? []).length === 0 && <div style={line}>{t('Keine Schichten geplant.')}</div>}
        {(h?.nextShifts ?? []).map((s) => (
          <div
            key={s.id}
            style={{ ...line, display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline' }}
            data-testid="next-shift"
          >
            <b style={{ minWidth: 92 }}>{dayLabel(s.date)}</b>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {ftime(s.start, TZ)}–{ftime(s.end, TZ)}
            </span>
            <span style={{ color: 'var(--color-neutral-700)', marginLeft: 'auto', fontSize: 12 }}>
              {s.shiftName ?? s.hotelName}
            </span>
          </div>
        ))}
      </section>
      <section style={card} aria-labelledby="h-week">
        <h2 id="h-week" style={cardHead}>
          {t('Diese Woche')}
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)' }}>
          {stat(t('Gearbeitet (freigegeben)'), `${fnum(h?.weekHours)} h`)}
          {stat(t('Geplant'), `${fnum(h?.weekPlannedHours)} h`)}
          {h?.targetHours != null && stat(t('Soll'), `${fnum(h.targetHours)} h`)}
        </div>
      </section>
      <div
        style={{ ...card, display: 'grid', gridTemplateColumns: h?.timeAccount != null ? '1fr 1fr' : '1fr' }}
      >
        {stat(t('Resturlaub'), `${fnum(h?.vacation?.remaining)} ${t('Tage')}`)}
        {h?.timeAccount != null && stat(t('Arbeitszeitkonto'), fsigned(h.timeAccount))}
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', margin: '0 var(--space-3)', flexWrap: 'wrap' }}>
        <NavLink className="btn btn-primary" to="/me/vacation?new=1">
          {t('Urlaub beantragen')}
        </NavLink>
        <NavLink className="btn btn-secondary" to="/me/attendance?correct=1">
          {t('Stempelzeit korrigieren')}
        </NavLink>
      </div>
      <section style={card} aria-labelledby="h-notes">
        <h2 id="h-notes" style={cardHead}>
          {t('Benachrichtigungen')}
        </h2>
        {(h?.notifications ?? []).length === 0 && <div style={line}>{t('Keine Benachrichtigungen.')}</div>}
        {(h?.notifications ?? []).map((n) => (
          <div
            key={n.id}
            style={{ ...line, display: 'flex', gap: 8, alignItems: 'center', fontWeight: n.read ? 400 : 700 }}
          >
            <span style={{ marginRight: 'auto' }}>{NOTE_TEXT(n, t)}</span>
            {!n.read && (
              <button className="btn btn-ghost" onClick={() => read.mutate(n.id)}>
                {t('Gelesen')}
              </button>
            )}
          </div>
        ))}
      </section>
    </main>
  );
}

// ---------------------------------------------------------------- schedule
