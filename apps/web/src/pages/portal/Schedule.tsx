import type { ColleagueList, ColleagueShiftDto, Items, MyScheduleDto } from '@dienst/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../../lib/api';
import { fnum, ftime } from '../../lib/format';
import { Dialog, ErrorNote, Field, useToast } from '../../components/ui';
import { addDaysIso, mondayOfIso, todayIso, weekRangeLabel } from '../planning/util';
import { TZ, card, dayLabel, line } from './common';
import { ABS } from './Attendance';

export function PortalSchedule() {
  const { t } = useTranslation();
  const [week, setWeek] = useState(() => mondayOfIso(todayIso()));
  const to = addDaysIso(week, 6);
  const s = useGet<MyScheduleDto>('/me/schedule', { from: week, to });
  const [swap, setSwap] = useState<MyScheduleEntry | null>(null);
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(week, i));
  const today = todayIso();
  return (
    <main>
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
      <section style={card}>
        {days.map((d) => {
          const entries = (s.data?.entries ?? []).filter((e) => e.date === d);
          const abs = (s.data?.absences ?? []).filter((a) => a.from <= d && a.to >= d);
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
              data-testid="sched-day"
            >
              <b>{dayLabel(d)}</b>
              <div>
                {entries.map((e) => (
                  <div key={e.id}>
                    <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                      {ftime(e.start, TZ)}–{ftime(e.end, TZ)}
                    </span>{' '}
                    <span style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
                      {e.shiftName ?? ''} · {e.hotelName} · {fnum(e.hours)} h
                    </span>
                    {new Date(e.start) > new Date() && (
                      <button className="btn btn-ghost" data-testid="swap-btn" onClick={() => setSwap(e)}>
                        {t('Tauschen')}
                      </button>
                    )}
                  </div>
                ))}
                {abs.map((a) => (
                  <div key={a.id} style={{ fontSize: 13 }}>
                    {t(ABS[a.type] ?? a.type)}
                    {a.status === 'pending' ? ` (${t('beantragt')})` : ''}
                  </div>
                ))}
                {!entries.length && !abs.length && (
                  <span style={{ color: 'var(--color-neutral-700)' }}>{t('frei')}</span>
                )}
              </div>
            </div>
          );
        })}
      </section>
      {swap && (
        <SwapDialog
          entry={swap}
          onClose={() => setSwap(null)}
          onDone={() => {
            setSwap(null);
            void s.refetch();
          }}
        />
      )}
    </main>
  );
}

function SwapDialog({
  entry,
  onClose,
  onDone,
}: {
  entry: MyScheduleEntry;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [mode, setMode] = useState<'anyone' | 'colleague'>('anyone');
  const [colleague, setColleague] = useState('');
  const [theirs, setTheirs] = useState('');
  const [reason, setReason] = useState('');
  const colleagues = useGet<ColleagueList>('/me/colleagues');
  const shifts = useGet<Items<ColleagueShiftDto>>(colleague ? `/me/colleagues/${colleague}/shifts` : null);
  const send = useSend('POST', '/me/swap-requests');
  return (
    <Dialog
      title={t('Schicht tauschen oder abgeben')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={send.isPending || (mode === 'colleague' && !colleague)}
            data-testid="swap-send"
            onClick={() =>
              send.mutate(
                {
                  scheduleId: entry.id,
                  reason: reason || undefined,
                  ...(mode === 'colleague'
                    ? {
                        counterpartEmployeeId: Number(colleague),
                        counterpartScheduleId: theirs ? Number(theirs) : undefined,
                      }
                    : {}),
                },
                {
                  onSuccess: () => {
                    toast(t('Anfrage gesendet'));
                    onDone();
                  },
                },
              )
            }
          >
            {t('Anfrage senden')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 13 }}>
        {dayLabel(entry.date)} {ftime(entry.start, TZ)}–{ftime(entry.end, TZ)} {entry.shiftName ?? ''}
      </p>
      <Field label={t('An wen?')} htmlFor="sw-mode">
        <select
          id="sw-mode"
          className="input"
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
        >
          <option value="anyone">{t('An alle geeigneten Kolleginnen und Kollegen')}</option>
          <option value="colleague">{t('An eine bestimmte Person')}</option>
        </select>
      </Field>
      {mode === 'colleague' && (
        <>
          <Field label={t('Person')} htmlFor="sw-col">
            <select
              id="sw-col"
              className="input"
              value={colleague}
              onChange={(e) => {
                setColleague(e.target.value);
                setTheirs('');
              }}
            >
              <option value="">–</option>
              {(colleagues.data?.items ?? []).map((c) => (
                <option key={c.employeeId} value={c.employeeId}>
                  {c.displayName} · {c.departmentName}
                </option>
              ))}
            </select>
          </Field>
          {colleague && (
            <Field label={t('Dafür deren Schicht übernehmen (optional)')} htmlFor="sw-theirs">
              <select
                id="sw-theirs"
                className="input"
                value={theirs}
                onChange={(e) => setTheirs(e.target.value)}
              >
                <option value="">{t('Keine, nur abgeben')}</option>
                {(shifts.data?.items ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {dayLabel(x.date)} {ftime(x.start, TZ)}–{ftime(x.end, TZ)} {x.shiftName ?? ''}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </>
      )}
      <Field label={t('Grund (optional)')} htmlFor="sw-reason">
        <input
          id="sw-reason"
          className="input"
          maxLength={300}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <p style={{ margin: 0, fontSize: 12 }}>
        {t('Die Leitung muss den Tausch freigeben, falls dies nicht automatisch geschieht.')}
      </p>
      <ErrorNote error={send.error} />
    </Dialog>
  );
}

type MyScheduleEntry = MyScheduleDto['entries'][number];
