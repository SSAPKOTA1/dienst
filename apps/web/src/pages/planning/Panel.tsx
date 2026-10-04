import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { fnum } from '../../lib/format';
import { Kicker, Label } from '../../components/ui';
import { WarnIcon, removeOp, type PlanCtx } from './Grid';
import type { GridEntry, GridRow, PlanOp } from './types';
import { ABSENCE_LABEL, DOW, addDaysIso, dayNum, dowOf, hm, rangeLabel, violationText } from './util';

function Warnings({ list }: { list: GridEntry['warnings'] }) {
  const { t } = useTranslation();
  return (
    <>
      {list.map((w, i) => {
        const x = violationText(w, t);
        return (
          <div
            key={i}
            style={{
              border: '2px solid var(--warn)',
              padding: 'var(--space-3)',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
            }}
            role="note"
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                color: 'var(--warn)',
              }}
            >
              <WarnIcon size={14} />
              {x.title}
            </div>
            <div style={{ fontSize: 13 }}>{x.msg}</div>
          </div>
        );
      })}
    </>
  );
}

export function SidePanel({
  ctx,
  onFinder,
}: {
  ctx: PlanCtx;
  onFinder: (e: GridEntry, row: GridRow) => void;
}) {
  const { t } = useTranslation();
  const { data, sel } = ctx;
  if (!sel)
    return (
      <div
        style={{
          fontSize: 13,
          color: 'var(--color-neutral-800)',
          border: '1px solid var(--color-divider)',
          padding: 'var(--space-3)',
        }}
      >
        {t('Wähle einen Eintrag im Plan oder ziehe Schichten per Drag & Drop.')}
      </div>
    );

  if (sel.kind === 'absence') {
    const a = data.absences.find((x) => x.id === sel.id);
    if (!a) return null;
    return (
      <>
        <div>
          <Kicker>{t('Abwesenheit')}</Kicker>
          <h2 style={{ margin: '2px 0', fontSize: 26, lineHeight: 1.1 }}>{a.displayName}</h2>
          <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
            {t(ABSENCE_LABEL[a.type] ?? a.type)}
            {a.status === 'pending' ? ` · ${t('beantragt')}` : ''} · {a.from} – {a.to}
          </div>
        </div>
        {a.type !== 'absent' && a.status === 'approved' && (
          <button
            className="btn btn-secondary"
            style={{ alignSelf: 'flex-start' }}
            data-testid="remove-absence"
            onClick={() =>
              void ctx.run({
                method: 'DELETE',
                path: `/schedule/absence/${a.id}`,
                done: 'Abwesenheit entfernt.',
              })
            }
          >
            {t('Abwesenheit entfernen')}
          </button>
        )}
        {a.status === 'pending' && (
          <div style={{ fontSize: 13 }}>{t('Der Antrag wird unter „Anträge“ entschieden.')}</div>
        )}
      </>
    );
  }

  const row =
    sel.kind === 'cell'
      ? data.rows.find((r) => r.key === sel.rowKey)
      : data.rows.find((r) => r.cells.some((c) => c.entries.some((e) => e.id === sel.id)));
  if (!row) return null;
  if (sel.kind === 'cell') return <CellPanel ctx={ctx} row={row} date={sel.date} />;
  const entry = row.cells.flatMap((c) => c.entries).find((e) => e.id === sel.id);
  if (!entry) return null;
  return <EntryPanel ctx={ctx} row={row} entry={entry} onFinder={onFinder} />;
}

function EntryPanel({
  ctx,
  row,
  entry,
  onFinder,
}: {
  ctx: PlanCtx;
  row: GridRow;
  entry: GridEntry;
  onFinder: (e: GridEntry, row: GridRow) => void;
}) {
  const { t } = useTranslation();
  const locked = entry.date < ctx.today;
  const change = ctx.data.changes.find((c) => c.entryId === entry.id);
  const [start, setStart] = useState(hm(entry.start));
  const [end, setEnd] = useState(hm(entry.end));
  const [brk, setBrk] = useState(String(entry.breakMinutes));
  const [reason, setReason] = useState('');
  const [toEmp, setToEmp] = useState(String(entry.employeeId));
  const [toDate, setToDate] = useState(entry.date);
  useEffect(() => {
    setStart(hm(entry.start));
    setEnd(hm(entry.end));
    setBrk(String(entry.breakMinutes));
    setToEmp(String(entry.employeeId));
    setToDate(entry.date);
    setReason('');
  }, [entry.id, entry.version, entry.start, entry.end, entry.breakMinutes, entry.employeeId, entry.date]);
  const employees = ctx.data.rows.filter((r) => r.kind === 'employee');
  const empRow = employees.find((r) => r.employeeId === entry.employeeId);
  const needsReason = entry.warnings.some((w) => w.severity !== 'warn');
  const dirty = start !== hm(entry.start) || end !== hm(entry.end) || Number(brk) !== entry.breakMinutes;
  const save = () => {
    const body: Record<string, any> = {
      version: entry.version,
      start,
      end,
      plannedBreakMinutes: Number(brk),
    };
    if (reason.trim().length >= 5) body.overrideReason = reason.trim();
    void ctx.run({ method: 'PUT', path: `/schedule/entries/${entry.id}`, body, done: 'Gespeichert.' });
  };
  const move = () => {
    const body: Record<string, any> = {
      entryId: entry.id,
      version: entry.version,
      toEmployeeId: Number(toEmp),
      toDate,
    };
    void ctx.run({ method: 'POST', path: '/schedule/move', body, done: 'Eintrag verschoben.' });
  };
  const target = empRow?.targetHours;
  return (
    <>
      <div>
        <Kicker>
          {t(DOW[dowOf(entry.date)])}, {dayNum(entry.date)}.{entry.date.slice(5, 7)}. ·{' '}
          {entry.change === 'removed'
            ? t('Entfernt')
            : entry.status === 'draft'
              ? t('Entwurf')
              : t('Veröffentlicht')}
        </Kicker>
        <h2 style={{ margin: '2px 0', fontSize: 26, lineHeight: 1.1 }}>{entry.displayName}</h2>
        <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
          {[row.departmentName, row.homeHotel?.name].filter(Boolean).join(' · ')}
        </div>
        {locked && (
          <span className="tag tag-neutral" style={{ marginTop: 6 }}>
            {t('Gesperrt (Vergangenheit)')}
          </span>
        )}
      </div>
      <hr className="hr" style={{ margin: 0 }} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
        <div>
          <Label>{t('Eintrag')}</Label>
          <div style={{ fontSize: 18, fontWeight: 800, marginTop: 2 }}>
            {entry.shiftName ?? t('Eigene Zeit')}
          </div>
          <div style={{ fontSize: 12 }}>
            {rangeLabel(entry.start, entry.end)} · {fnum(entry.hours)} {t('Std.')} {t('bezahlt')}
          </div>
        </div>
        <div>
          <Label>{t('Woche gesamt')}</Label>
          <div style={{ fontSize: 18, fontWeight: 800, marginTop: 2 }}>
            {empRow ? `${fnum(empRow.totalHours)} ${t('Std.')}` : '–'}
          </div>
          {target != null && (
            <div style={{ fontSize: 12 }}>
              {t('Soll')} {fnum(target)} {t('Std.')}
            </div>
          )}
        </div>
      </div>
      <Warnings list={entry.warnings} />
      {change && (
        <div
          style={{
            border: '2px solid var(--color-divider)',
            padding: 'var(--space-3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase' }}>
            {t('Ungeveröffentlichte Änderung')}
          </div>
          {change.from && change.type !== 'new' && (
            <div style={{ fontSize: 13 }}>
              {t('Vorher')}: {change.from.date} {rangeLabel(change.from.start, change.from.end)}
            </div>
          )}
          <button
            className="btn btn-secondary"
            style={{ alignSelf: 'flex-start' }}
            onClick={() =>
              void ctx.run({
                method: 'POST',
                path: '/schedule/revert',
                body: { hotelIds: [entry.hotelId], from: entry.date, to: entry.date, entryId: entry.id },
                done: 'Änderung verworfen.',
              })
            }
          >
            {t('Änderung verwerfen')}
          </button>
        </div>
      )}
      {!locked && entry.change !== 'removed' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <div className="field">
              <label htmlFor="ps">{t('Beginn')}</label>
              <input
                id="ps"
                className="input"
                value={start}
                maxLength={5}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="pe">{t('Ende')}</label>
              <input
                id="pe"
                className="input"
                value={end}
                maxLength={5}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="pb">{t('Pause (Min.)')}</label>
              <input id="pb" className="input" value={brk} onChange={(e) => setBrk(e.target.value)} />
            </div>
          </div>
          {(needsReason || dirty) && (
            <div className="field">
              <label htmlFor="pr">{t('Begründung (bei Minderjährigen Pflicht, wird protokolliert)')}</label>
              <textarea
                id="pr"
                className="input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div className="field">
              <label htmlFor="pm1">{t('Mitarbeiter')}</label>
              <select id="pm1" className="input" value={toEmp} onChange={(e) => setToEmp(e.target.value)}>
                {employees.map((r) => (
                  <option key={r.key} value={r.employeeId}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pm2">{t('Datum')}</label>
              <select id="pm2" className="input" value={toDate} onChange={(e) => setToDate(e.target.value)}>
                {ctx.data.days
                  .filter((d) => d.date >= ctx.today)
                  .map((d) => (
                    <option key={d.date} value={d.date}>
                      {t(DOW[dowOf(d.date)])} {dayNum(d.date)}.
                    </option>
                  ))}
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            <button className="btn btn-primary" disabled={!dirty} onClick={save} data-testid="save-entry">
              {t('Speichern')}
            </button>
            <button
              className="btn btn-secondary"
              disabled={toEmp === String(entry.employeeId) && toDate === entry.date}
              onClick={move}
            >
              {t('Verschieben')}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => onFinder(entry, row)}
              data-testid="find-substitute"
            >
              {t('Vertretung finden')}
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => void ctx.run(removeOp(entry))}
              data-testid="remove-entry"
            >
              {t('Entfernen')}
            </button>
          </div>
        </>
      )}
    </>
  );
}

function CellPanel({ ctx, row, date }: { ctx: PlanCtx; row: GridRow; date: string }) {
  const { t } = useTranslation();
  const cell = row.cells.find((c) => c.date === date);
  const locked = date < ctx.today;
  const [people, setPeople] = useState<any[] | null>(null);
  const shiftRow = row.kind !== 'employee';
  useEffect(() => {
    setPeople(null);
    if (!shiftRow || !row.shiftId || locked) return;
    let alive = true;
    api('/schedule/candidates', { query: { hotelIds: row.hotelId ?? undefined, shiftId: row.shiftId, date } })
      .then((r) => alive && setPeople(r.items))
      .catch(() => alive && setPeople([]));
    return () => {
      alive = false;
    };
  }, [shiftRow, row.shiftId, row.hotelId, date, locked, cell?.entries.length]);
  const tpls = ctx.shifts.filter((s) => ctx.data.hotelIds.includes(s.hotelId));
  const emp = row.kind === 'employee' ? row : null;
  const op = (body: Record<string, any>, path = '/schedule/entries'): PlanOp => ({
    method: 'POST',
    path,
    body,
    done: 'Eintrag gespeichert.',
  });
  return (
    <>
      <div>
        <Kicker>
          {shiftRow ? t('Dienst') : `${t(DOW[dowOf(date)])}, ${dayNum(date)}.${date.slice(5, 7)}.`}
        </Kicker>
        <h2 style={{ margin: '2px 0', fontSize: 26, lineHeight: 1.1 }}>{row.name ?? row.label}</h2>
        {shiftRow && cell && (
          <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
            {t('Besetzung')}{' '}
            <b style={{ color: (cell.open ?? 0) > 0 ? 'var(--warn)' : undefined }}>
              {cell.assigned}/{cell.required}
            </b>{' '}
            · {t(DOW[dowOf(date)])} {dayNum(date)}.
          </div>
        )}
        {emp && (
          <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
            {[emp.departmentName, emp.homeHotel?.name].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
      <hr className="hr" style={{ margin: 0 }} />
      {locked && (
        <div style={{ fontSize: 13, border: '1px solid var(--color-divider)', padding: 'var(--space-3)' }}>
          {t('Vergangener Tag. Keine Änderungen möglich.')}
        </div>
      )}
      {!locked && emp && (
        <>
          <div style={{ fontSize: 13 }}>{t('Kein Eintrag. Zuweisen:')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            {tpls.map((s) => (
              <button
                key={s.id}
                className="btn btn-secondary"
                onClick={() =>
                  void ctx.run(op({ hotelId: s.hotelId, employeeId: emp.employeeId, shiftId: s.id, date }))
                }
              >
                {s.name} {s.startTime}–{s.endTime}
              </button>
            ))}
          </div>
        </>
      )}
      {!locked && shiftRow && (
        <>
          <Label>{t('Verfügbare Mitarbeiter')}</Label>
          <div style={{ borderTop: '2px solid var(--color-divider)' }}>
            {(people ?? []).map((p) => (
              <div
                key={p.employeeId}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0,1fr) auto',
                  gap: 8,
                  padding: '8px 0',
                  borderBottom: '1px solid var(--color-divider)',
                  alignItems: 'center',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{p.displayName}</span>
                    {p.isFloater && (
                      <span className="tag tag-outline" style={{ padding: '0 5px', fontSize: 10 }}>
                        {t('Springer')}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
                    {fnum(p.weekHours)} {t('Std.')}
                    {p.targetHours != null ? ` ${t('von')} ${fnum(p.targetHours)}` : ''}
                  </div>
                  {p.warnings.length > 0 && (
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--warn)' }}>
                      {violationText(p.warnings[0], t).title}
                    </div>
                  )}
                </div>
                <button
                  className="btn btn-secondary"
                  onClick={() =>
                    void ctx.run(
                      op({ hotelId: row.hotelId, employeeId: p.employeeId, shiftId: row.shiftId, date }),
                    )
                  }
                >
                  {t('Zuweisen')}
                </button>
              </div>
            ))}
            {people && people.length === 0 && (
              <div style={{ padding: 'var(--space-3) 0', fontSize: 13 }}>{t('Niemand verfügbar.')}</div>
            )}
          </div>
        </>
      )}
      <div style={{ display: 'none' }}>{addDaysIso(date, 0)}</div>
    </>
  );
}
