import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { api } from '../../lib/api';
import { fnum } from '../../lib/format';
import type {
  DropState,
  GridAbsence,
  GridCell,
  GridData,
  GridEntry,
  GridRow,
  PlanOp,
  Sel,
  ShiftTpl,
} from './types';
import {
  ABSENCE_LABEL,
  EXTRA_ABSENCES,
  DOW,
  dayNum,
  dowOf,
  rangeLabel,
  violationText,
  addDaysIso,
} from './util';

export interface PlanCtx {
  data: GridData;
  shifts: ShiftTpl[];
  sel: Sel;
  setSel: (s: Sel) => void;
  drop: Record<string, DropState>;
  dragging: boolean;
  run: (op: PlanOp | PlanOp[]) => Promise<boolean>;
  range: { rowKey: string; from: string; to: string } | null;
  setRange: (r: { rowKey: string; from: string; to: string } | null) => void;
  today: string;
}
export const PlanContext = createContext<PlanCtx>(null as unknown as PlanCtx);
const usePlan = () => useContext(PlanContext);

export const WarnIcon = ({ size = 13 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.6"
    aria-hidden
  >
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </svg>
);
const Scissors = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.6"
    aria-hidden
  >
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M20 4 8.12 15.88" />
    <path d="M14.47 14.48 20 20" />
    <path d="M8.12 8.12 12 12" />
  </svg>
);

function mergeRefs<T>(...refs: Array<(el: T | null) => void>) {
  return (el: T | null) => refs.forEach((r) => r(el));
}

// ---------------------------------------------------------------------------------------------
// chips

function EntryChip({
  entry,
  cell,
  shiftView,
  tabIndex,
}: {
  entry: GridEntry;
  cell: GridCell;
  shiftView: boolean;
  tabIndex: number;
}) {
  const { t } = useTranslation();
  const ctx = usePlan();
  const locked = !!cell.locked || !!entry.readOnly || entry.change === 'removed';
  const drag = useDraggable({ id: `entry:${entry.id}`, data: { type: 'entry', entry }, disabled: locked });
  const drop = useDroppable({ id: `chip:${entry.id}`, data: { type: 'chip', entry }, disabled: locked });
  const state = ctx.drop[`chip:${entry.id}`];
  const sel = ctx.sel?.kind === 'entry' && ctx.sel.id === entry.id;
  const cls = [
    'pl-chip',
    entry.status === 'draft' && entry.change !== 'removed' ? 'draft' : '',
    entry.change === 'changed' ? 'changed' : '',
    entry.change === 'removed' ? 'removed' : '',
    entry.isOtherHotel ? 'other' : '',
    locked ? 'locked' : '',
    sel ? 'sel' : '',
    drag.isDragging ? 'dragging' : '',
    state === 'ok'
      ? 'drop-ok'
      : state === 'needs_reason'
        ? 'drop-reason'
        : state === 'blocked'
          ? 'drop-blocked'
          : '',
  ]
    .filter(Boolean)
    .join(' ');
  const warn = entry.warnings.length ? violationText(entry.warnings[0], t) : null;
  const time = rangeLabel(entry.start, entry.end);
  const status =
    entry.change === 'removed'
      ? t('Entfernt')
      : entry.status === 'draft'
        ? t('Entwurf')
        : t('Veröffentlicht');
  const label = entry.isOtherHotel
    ? `${t('In')} ${entry.otherHotelName}, ${time}`
    : `${entry.displayName}, ${entry.shiftName ?? ''} ${time}, ${status}${warn ? `, ${t('Warnung')}: ${warn.title}` : ''}`;
  const canRemove = !locked && !entry.isOtherHotel;
  return (
    <div
      ref={mergeRefs<HTMLDivElement>(drag.setNodeRef, drop.setNodeRef)}
      className={cls}
      data-testid={`entry-${entry.id}`}
      {...(locked ? {} : drag.listeners)}
      {...(locked ? {} : drag.attributes)}
      role="button"
      tabIndex={tabIndex}
      aria-label={label}
      title={warn ? `${warn.title}: ${warn.msg}` : undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (!entry.isOtherHotel) ctx.setSel({ kind: 'entry', id: entry.id });
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !entry.isOtherHotel) {
          e.preventDefault();
          ctx.setSel({ kind: 'entry', id: entry.id });
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && canRemove) {
          e.preventDefault();
          void ctx.run(removeOp(entry));
        }
      }}
    >
      {entry.isOtherHotel ? (
        <>
          <span className="n" style={{ fontSize: 11, fontWeight: 600 }}>
            {t('In')} {entry.otherHotelName}
          </span>
          <span className="t">{time}</span>
        </>
      ) : shiftView ? (
        <span className="n">{entry.displayName}</span>
      ) : (
        <>
          <span className="n">{entry.shiftName ?? t('Eigene Zeit')}</span>
          <span className="t">{time}</span>
        </>
      )}
      {warn && (
        <span className="pl-warn" style={{ right: canRemove ? 22 : 4 }}>
          <WarnIcon size={shiftView ? 11 : 13} />
        </span>
      )}
      {canRemove && (
        <button
          type="button"
          className="pl-rm"
          aria-label={t('Entfernen')}
          tabIndex={-1}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void ctx.run(removeOp(entry));
          }}
        >
          <Scissors />
        </button>
      )}
    </div>
  );
}

export const removeOp = (e: GridEntry): PlanOp => ({
  method: 'DELETE',
  path: `/schedule/entries/${e.id}?version=${e.version}`,
  done: 'Eintrag entfernt.',
});

function AbsenceChip({ a, cell, rowKey }: { a: GridAbsence; cell: GridCell; rowKey: string }) {
  const { t } = useTranslation();
  const ctx = usePlan();
  const sel = ctx.sel?.kind === 'absence' && ctx.sel.id === a.id;
  void cell;
  void rowKey;
  const label = `${t(ABSENCE_LABEL[a.type] ?? a.type)}${a.status === 'pending' ? ` (${t('beantragt')})` : ''}`;
  return (
    <button
      type="button"
      className={`pl-abs ${a.status === 'pending' ? 'pending' : ''} ${a.type === 'off_day' ? 'off' : ''}`}
      style={sel ? { outline: '2px solid var(--color-accent)' } : undefined}
      onClick={(e) => {
        e.stopPropagation();
        ctx.setSel({ kind: 'absence', id: a.id });
      }}
      aria-label={label}
      tabIndex={-1}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// + menu

interface MenuTarget {
  anchor: DOMRect;
  row: GridRow;
  cell: GridCell;
  returnTo: HTMLElement | null;
}

function CellMenu({ target, onClose }: { target: MenuTarget; onClose: () => void }) {
  const { t } = useTranslation();
  const ctx = usePlan();
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const { row, cell } = target;
  const shiftView = row.kind !== 'employee';
  const range =
    ctx.range && ctx.range.rowKey === row.key && ctx.range.from <= cell.date && ctx.range.to >= cell.date
      ? ctx.range
      : null;
  const from = range?.from ?? cell.date;
  const to = range?.to ?? cell.date;
  const past = cell.date < ctx.today;

  const cands = useMemo(() => ({ key: `${row.shiftId}:${cell.date}` }), [row.shiftId, cell.date]);
  const [people, setPeople] = useState<any[] | null>(null);
  useEffect(() => {
    if (!shiftView || !row.shiftId || past) return;
    let alive = true;
    api('/schedule/candidates', {
      query: {
        hotelIds: row.hotelId ?? undefined,
        shiftId: row.shiftId,
        date: cell.date,
        includeBlocked: 'true',
      },
    })
      .then((r) => alive && setPeople(r.items))
      .catch(() => alive && setPeople([]));
    return () => {
      alive = false;
    };
  }, [cands.key, shiftView, row.shiftId, row.hotelId, cell.date, past]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = target.anchor;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = r.left + window.scrollX;
    let top = r.bottom + window.scrollY + 2;
    if (left + w > window.scrollX + window.innerWidth - 8) left = window.scrollX + window.innerWidth - w - 8;
    if (r.bottom + h > window.innerHeight - 8 && r.top - h > 8) top = r.top + window.scrollY - h - 2;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('input,button:not([disabled])');
    first?.focus();
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose, people]);

  const close = () => {
    onClose();
    setTimeout(() => target.returnTo?.focus(), 0);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('input,button:not([disabled])') ?? [])];
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === 'ArrowDown' ? items[(i + 1) % items.length] : items[(i - 1 + items.length) % items.length];
      next?.focus();
    }
  };

  const days: string[] = [];
  for (let d = from; d <= to; d = addDaysIso(d, 1)) days.push(d);

  const pickShift = (s: ShiftTpl) => {
    const ops: PlanOp[] = (past ? [] : days.filter((d) => d >= ctx.today)).map((d) => ({
      method: 'POST',
      path: '/schedule/entries',
      body: { hotelId: s.hotelId, employeeId: row.employeeId, shiftId: s.id, date: d },
      done: 'Eintrag gespeichert.',
    }));
    close();
    if (ops.length)
      void ctx.run(
        ops.length === 1
          ? ops[0]
          : {
              method: 'POST',
              path: '/schedule/bulk',
              body: { operations: ops.map((o) => ({ op: 'create', ...o.body })) },
              done: 'Einträge gespeichert.',
            },
      );
  };
  const pickAbsence = (type: string) => {
    close();
    void ctx.run({
      method: 'POST',
      path: '/schedule/absence',
      body: { employeeId: row.employeeId, from, to, type },
      done: 'Abwesenheit eingetragen.',
    });
  };
  const pickPerson = (p: any) => {
    close();
    void ctx.run({
      method: 'POST',
      path: '/schedule/entries',
      body: { hotelId: row.hotelId, employeeId: p.employeeId, shiftId: row.shiftId, date: cell.date },
      done: 'Eintrag gespeichert.',
    });
  };

  const tpls = ctx.shifts.filter(
    (s) =>
      s.hotelId === row.hotelId ||
      (row.homeHotel && s.hotelId === row.homeHotel.id) ||
      ctx.data.hotelIds.includes(s.hotelId),
  );
  const own = tpls.filter((s) => s.departmentId === row.departmentId);
  const rest = tpls.filter((s) => s.departmentId !== row.departmentId);
  const multiHotel = ctx.data.hotelIds.length > 1;
  const tplLabel = (s: ShiftTpl) => `${s.name} ${s.startTime}–${s.endTime}`;
  const absences = past
    ? ['sick_leave']
    : ['sick_leave', 'off_day', 'annual_leave', 'unpaid_leave', 'vocational_school'];

  const body = shiftView ? (
    <>
      {!past && (
        <div style={{ padding: 8, borderBottom: '1px solid var(--color-divider)' }}>
          <input
            className="input"
            placeholder={t('Name suchen')}
            aria-label={t('Name suchen')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      )}
      {past && <div className="sec">{t('Vergangener Tag. Keine Änderungen möglich.')}</div>}
      {people === null && !past && <div className="sec">…</div>}
      {(people ?? [])
        .filter((p) => p.displayName.toLowerCase().includes(q.toLowerCase()))
        .map((p) => {
          const reason = p.blocked
            ? violationText(p.warnings.find((w: any) => w.severity === 'block') ?? p.warnings[0], t)
            : null;
          return (
            <button
              key={p.employeeId}
              type="button"
              disabled={p.blocked}
              onClick={() => pickPerson(p)}
              data-testid={`pick-${p.employeeId}`}
            >
              <span>
                {p.displayName}
                {reason && (
                  <span style={{ display: 'block', fontSize: 11 }}>
                    {reason.title}: {reason.msg}
                  </span>
                )}
                {!p.blocked && p.warnings.length > 0 && (
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--warn)' }}>
                    {violationText(p.warnings[0], t).title}
                  </span>
                )}
              </span>
              <span style={{ fontSize: 11 }}>{p.weekHours != null ? `${fnum(p.weekHours)} h` : ''}</span>
            </button>
          );
        })}
    </>
  ) : (
    <>
      {!past && (
        <>
          <div className="sec">{t('Schichten')}</div>
          {[...own, ...rest].map((s) => (
            <button key={s.id} type="button" onClick={() => pickShift(s)} data-testid={`tpl-${s.id}`}>
              <span>{tplLabel(s)}</span>
              {multiHotel && (
                <span style={{ fontSize: 11 }}>
                  {ctx.data.rows.find((r) => r.hotelId === s.hotelId)?.hotelName ?? ''}
                </span>
              )}
            </button>
          ))}
        </>
      )}
      <div className="sec">{t('Abwesenheit')}</div>
      {absences.map((a) => (
        <button key={a} type="button" onClick={() => pickAbsence(a)} data-testid={`abs-${a}`}>
          {t(
            a === 'sick_leave'
              ? 'Krank'
              : a === 'off_day'
                ? 'Frei'
                : a === 'annual_leave'
                  ? 'Urlaub'
                  : a === 'unpaid_leave'
                    ? 'Unbezahlt frei'
                    : 'Berufsschule',
          )}
        </button>
      ))}
      {!past && (
        <>
          <div className="sec">{t('Mehr')}</div>
          {EXTRA_ABSENCES.map((a) => (
            <button key={a} type="button" onClick={() => pickAbsence(a)} data-testid={`abs-${a}`}>
              {t(ABSENCE_LABEL[a] ?? a)}
            </button>
          ))}
        </>
      )}
    </>
  );
  return createPortal(
    <div
      ref={ref}
      className="pl-menu"
      role="menu"
      aria-label={t('Eintrag hinzufügen')}
      onKeyDown={onKey}
      style={{ left: 0, top: 0 }}
      data-testid="cell-menu"
    >
      {range && range.from !== range.to && (
        <div className="sec">
          {from.slice(5)} – {to.slice(5)}
        </div>
      )}
      {body}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------------------------
// cells

interface Nav {
  rIdx: number;
  cIdx: number;
  active: boolean;
  setActive: (r: number, c: number) => void;
}

function Cell({
  row,
  cell,
  nav,
  shiftView,
  onMenu,
}: {
  row: GridRow;
  cell: GridCell;
  nav: Nav;
  shiftView: boolean;
  onMenu: (t: MenuTarget) => void;
}) {
  const { t } = useTranslation();
  const ctx = usePlan();
  const id = `cell:${row.key}:${cell.date}`;
  const locked = !!cell.locked;
  const drop = useDroppable({
    id,
    data: { type: 'cell', row, cell },
    disabled: locked && row.kind === 'employee' && false,
  });
  const state = ctx.drop[id];
  const selected = ctx.sel?.kind === 'cell' && ctx.sel.rowKey === row.key && ctx.sel.date === cell.date;
  const inRange =
    !!ctx.range && ctx.range.rowKey === row.key && ctx.range.from <= cell.date && ctx.range.to >= cell.date;
  const absences = (cell.absenceIds ?? [])
    .map((aid) => ctx.data.absences.find((a) => a.id === aid))
    .filter(Boolean) as GridAbsence[];
  const live = cell.entries;
  const empty = live.filter((e) => e.change !== 'removed').length === 0 && absences.length === 0;
  const addRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLButtonElement>(null);
  const warnCount = live.filter((e) => e.warnings.length).length;
  const cls = [
    'pl-cell',
    shiftView ? 'pl-cell-shift' : '',
    locked ? 'is-past' : '',
    selected || inRange ? 'is-sel' : '',
    state === 'ok'
      ? 'drop-ok'
      : state === 'needs_reason'
        ? 'drop-reason'
        : state === 'blocked'
          ? 'drop-blocked'
          : state === 'pending'
            ? 'drop-pending'
            : '',
  ]
    .filter(Boolean)
    .join(' ');
  const dow = t(DOW[dowOf(cell.date)]);
  const desc = `${row.label}, ${dow} ${dayNum(cell.date)}, ${empty ? t('Leer') : [...live.map((e) => `${e.shiftName ?? ''} ${rangeLabel(e.start, e.end)}`), ...absences.map((a) => t(ABSENCE_LABEL[a.type] ?? a.type))].join(', ')}${locked ? `, ${t('Vergangen · gesperrt')}` : ''}${shiftView ? `, ${cell.assigned}/${cell.required}` : ''}`;
  const openMenu = () => {
    const el = addRef.current ?? mainRef.current;
    if (!el) return;
    onMenu({ anchor: el.getBoundingClientRect(), row, cell, returnTo: mainRef.current });
  };
  const canAdd = !(locked && cell.locked === 'closed') && (row.kind === 'employee' ? true : !locked);
  void warnCount;
  return (
    <div
      ref={drop.setNodeRef}
      className={cls}
      role="gridcell"
      data-testid={shiftView ? `cell-${row.key}-${cell.date}` : `cell-${row.employeeId}-${cell.date}`}
      data-r={nav.rIdx}
      data-c={nav.cIdx}
      title={locked ? t('Vergangen · gesperrt') : undefined}
    >
      <button
        ref={mainRef}
        type="button"
        className="pl-main"
        tabIndex={nav.active ? 0 : -1}
        aria-label={desc}
        onFocus={() => nav.setActive(nav.rIdx, nav.cIdx)}
        onClick={(e) => {
          nav.setActive(nav.rIdx, nav.cIdx);
          if (e.shiftKey && !shiftView && ctx.sel?.kind === 'cell' && ctx.sel.rowKey === row.key) {
            const a = ctx.sel.date < cell.date ? ctx.sel.date : cell.date;
            const b = ctx.sel.date < cell.date ? cell.date : ctx.sel.date;
            ctx.setRange({ rowKey: row.key, from: a, to: b });
            return;
          }
          ctx.setRange(null);
          const first = live.find((x) => x.change !== 'removed' && !x.isOtherHotel);
          ctx.setSel(
            first && e.detail === 0
              ? { kind: 'entry', id: first.id }
              : { kind: 'cell', rowKey: row.key, date: cell.date },
          );
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const first = live.find((x) => x.change !== 'removed' && !x.isOtherHotel);
            if (first) ctx.setSel({ kind: 'entry', id: first.id });
            else if (canAdd) {
              ctx.setSel({ kind: 'cell', rowKey: row.key, date: cell.date });
              openMenu();
            }
          }
          if ((e.key === '+' || e.key === 'Insert') && canAdd) {
            e.preventDefault();
            openMenu();
          }
          if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !shiftView) {
            e.preventDefault();
            const anchor =
              ctx.range && ctx.range.rowKey === row.key
                ? cell.date === ctx.range.from
                  ? ctx.range.to
                  : ctx.range.from
                : cell.date;
            const nd = addDaysIso(cell.date, e.key === 'ArrowRight' ? 1 : -1);
            ctx.setRange({ rowKey: row.key, from: nd < anchor ? nd : anchor, to: nd < anchor ? anchor : nd });
            ctx.setSel({ kind: 'cell', rowKey: row.key, date: anchor });
            const next = (
              e.currentTarget.closest('[role=grid]') as HTMLElement | null
            )?.querySelector<HTMLElement>(
              `[data-r="${nav.rIdx}"][data-c="${nav.cIdx + (e.key === 'ArrowRight' ? 1 : -1)}"] .pl-main`,
            );
            next?.focus();
            e.stopPropagation();
          }
        }}
      />
      {live.map((e) => (
        <EntryChip
          key={`${e.id}-${e.change ?? ''}`}
          entry={e}
          cell={cell}
          shiftView={shiftView}
          tabIndex={nav.active ? 0 : -1}
        />
      ))}
      {absences.map((a) => (
        <AbsenceChip key={a.id} a={a} cell={cell} rowKey={row.key} />
      ))}
      {shiftView && (
        <span
          className="pl-count"
          style={{
            order: -1,
            color: (cell.open ?? 0) > 0 ? 'var(--warn)' : undefined,
            fontWeight: (cell.open ?? 0) > 0 ? 800 : 400,
          }}
        >
          {cell.assigned}/{cell.required}
          {(cell.open ?? 0) > 0 && ` · ${cell.open} ${t('offen')}`}
        </span>
      )}
      {shiftView &&
        Array.from({ length: Math.min(cell.open ?? 0, 3) }).map((_, i) => (
          <span
            key={i}
            aria-hidden
            style={{ border: '1px dashed var(--color-neutral-600)', height: 22, pointerEvents: 'none' }}
          />
        ))}
      {canAdd && (
        <button
          ref={addRef}
          type="button"
          className="pl-add"
          aria-label={`${t('Eintrag hinzufügen')}: ${row.label}, ${dow} ${dayNum(cell.date)}`}
          data-testid={shiftView ? `add-${row.key}-${cell.date}` : `add-${row.employeeId}-${cell.date}`}
          tabIndex={nav.active ? 0 : -1}
          onClick={(e) => {
            e.stopPropagation();
            openMenu();
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            aria-hidden
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// grids

function DayHeader({ data, lead, trail }: { data: GridData; lead: string; trail?: string }) {
  const { t } = useTranslation();
  return (
    <div
      className={trail ? 'pl-cols' : 'pl-cols-shift'}
      style={{ borderBottom: '2px solid var(--color-divider)' }}
      role="row"
    >
      <div
        style={{
          padding: '6px var(--space-4)',
          fontSize: 11,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: 'var(--color-neutral-700)',
          alignSelf: 'end',
        }}
      >
        {lead}
      </div>
      {data.days.map((d) => {
        const today = d.date === todayLocal();
        return (
          <div
            key={d.date}
            className="pl-head"
            style={{
              background: today ? 'var(--color-accent-100)' : d.past ? 'var(--color-neutral-200)' : undefined,
            }}
            title={d.holiday ?? undefined}
          >
            <span
              style={{
                fontSize: 11,
                letterSpacing: '.08em',
                textTransform: 'uppercase',
                color: 'var(--color-neutral-700)',
              }}
            >
              {t(DOW[dowOf(d.date)])}
            </span>
            <span style={{ fontWeight: 800, fontSize: 16 }}>{dayNum(d.date)}.</span>
            {d.holiday && (
              <span
                style={{
                  flexBasis: '100%',
                  fontSize: 10,
                  color: 'var(--color-accent-700)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {d.holiday}
              </span>
            )}
          </div>
        );
      })}
      {trail && (
        <div
          style={{
            padding: '6px 8px',
            borderLeft: '1px solid var(--color-divider)',
            fontSize: 11,
            letterSpacing: '.08em',
            textTransform: 'uppercase',
            color: 'var(--color-neutral-700)',
            alignSelf: 'end',
          }}
        >
          {trail}
        </div>
      )}
    </div>
  );
}
const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());

export function PlanGrid() {
  const { t } = useTranslation();
  const ctx = usePlan();
  const { data } = ctx;
  const shiftView = data.view === 'shift';
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [active, setActive] = useState<[number, number]>([0, 0]);
  const gridRef = useRef<HTMLDivElement>(null);

  // groups: hotel + department (employee view) or the same for shift rows
  const groups = useMemo(() => {
    const g: Array<{
      key: string;
      title: string;
      hotelId: number | null;
      deptId: number | null;
      rows: GridRow[];
    }> = [];
    for (const r of data.rows) {
      const hotelName = r.hotelName ?? '';
      const key = `${r.hotelId}:${r.departmentId}`;
      let grp = g.find((x) => x.key === key);
      if (!grp) {
        grp = {
          key,
          title: [r.departmentName || t('Ohne Schicht'), hotelName].filter(Boolean).join(' · '),
          hotelId: r.hotelId,
          deptId: r.departmentId,
          rows: [],
        };
        g.push(grp);
      }
      grp.rows.push(r);
    }
    const deptRank = (name: string) => {
      const i = ['Rezeption', 'Housekeeping', 'Frühstück'].indexOf(name);
      return i < 0 ? 99 : i;
    };
    return g.sort(
      (a, b) =>
        deptRank(a.title.split(' · ')[0]) - deptRank(b.title.split(' · ')[0]) ||
        (a.hotelId ?? 0) - (b.hotelId ?? 0),
    );
  }, [data.rows, t]);

  const flat = groups.flatMap((g) => g.rows);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) || e.shiftKey)
      return;
    const tgt = e.target as HTMLElement;
    if (!tgt.classList.contains('pl-main') && !tgt.classList.contains('pl-chip')) return;
    e.preventDefault();
    let [r, c] = active;
    if (e.key === 'ArrowRight') c = Math.min(6, c + 1);
    if (e.key === 'ArrowLeft') c = Math.max(0, c - 1);
    if (e.key === 'ArrowDown') r = Math.min(flat.length - 1, r + 1);
    if (e.key === 'ArrowUp') r = Math.max(0, r - 1);
    if (e.key === 'Home') c = 0;
    if (e.key === 'End') c = 6;
    setActive([r, c]);
    requestAnimationFrame(() =>
      gridRef.current?.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"] .pl-main`)?.focus(),
    );
  };

  const dayCoverage = (g: (typeof groups)[number], date: string) =>
    data.coverage.find((c) => c.hotelId === g.hotelId && c.departmentId === g.deptId && c.date === date);
  let rIdx = -1;
  return (
    <div className="pl-scroll" style={{ overflowX: 'auto', borderTop: '2px solid var(--color-divider)' }}>
      <div
        ref={gridRef}
        role="grid"
        aria-label={t('Dienstplan')}
        aria-rowcount={flat.length}
        style={{ minWidth: 820 }}
        onKeyDown={onKeyDown}
      >
        <DayHeader
          data={data}
          lead={shiftView ? t('Dienst') : t('Mitarbeiter')}
          trail={shiftView ? undefined : t('Std.')}
        />
        {groups.length === 0 && (
          <div style={{ padding: 'var(--space-8) var(--space-4)', fontSize: 15 }}>
            {t('Keine Hotels oder Abteilungen ausgewählt. Wähle oben mindestens eines aus.')}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.key}>
            <div className="pl-group">{g.title}</div>
            {g.rows.map((row) => {
              rIdx++;
              const ri = rIdx;
              return (
                <div
                  key={row.key}
                  role="row"
                  data-row
                  className={`${shiftView ? 'pl-cols-shift' : 'pl-cols'} pl-row`}
                  style={shiftView ? { borderBottom: '2px solid var(--color-divider)' } : undefined}
                >
                  {shiftView ? (
                    <div role="rowheader" style={{ padding: '8px var(--space-4)' }}>
                      <div style={{ fontSize: 15, fontWeight: 800 }}>{row.name ?? t(row.label)}</div>
                      {row.startTime && (
                        <div style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                          {row.startTime}–{row.endTime}
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: 'var(--color-neutral-700)' }}>
                        {fnum(row.totalHours)} {t('Std.')}
                      </div>
                    </div>
                  ) : (
                    <div
                      role="rowheader"
                      style={{
                        padding: '4px var(--space-4)',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        minWidth: 0,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => ctx.setSel({ kind: 'cell', rowKey: row.key, date: data.days[0].date })}
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          textAlign: 'left',
                          border: 0,
                          background: 'transparent',
                          padding: 0,
                          cursor: 'pointer',
                          color: 'var(--color-text)',
                        }}
                        tabIndex={-1}
                      >
                        {row.label}
                      </button>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                        {row.personnelNumber && (
                          <span style={{ fontSize: 11, color: 'var(--color-neutral-700)' }}>
                            {row.personnelNumber}
                          </span>
                        )}
                        {row.isMinor && (
                          <span className="tag tag-accent" style={{ padding: '0 5px', fontSize: 10 }}>
                            U18
                          </span>
                        )}
                        {row.isFloater && (
                          <span className="tag tag-outline" style={{ padding: '0 5px', fontSize: 10 }}>
                            {t('Springer')}
                          </span>
                        )}
                        {row.isOtherHotel && (
                          <span className="tag tag-outline" style={{ padding: '0 5px', fontSize: 10 }}>
                            {t('Stammhaus')}: {row.homeHotel?.name}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {row.cells.map((cell, ci) => (
                    <Cell
                      key={cell.date}
                      row={row}
                      cell={cell}
                      shiftView={shiftView}
                      nav={{
                        rIdx: ri,
                        cIdx: ci,
                        active: active[0] === ri && active[1] === ci,
                        setActive: (r, c) => setActive([r, c]),
                      }}
                      onMenu={setMenu}
                    />
                  ))}
                  {!shiftView && (
                    <div
                      style={{
                        borderLeft: '1px solid var(--color-divider)',
                        padding: '4px 8px',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 800 }}>
                        {fnum(row.totalHours + (row.creditHours ?? 0))} h
                      </span>
                      {row.targetHours != null && (
                        <span style={{ fontSize: 10, color: 'var(--color-neutral-700)' }}>
                          {t('von')} {fnum(row.targetHours)} h
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {!shiftView &&
              data.coverage.some((c) => c.hotelId === g.hotelId && c.departmentId === g.deptId) && (
                <div
                  className="pl-cols"
                  style={{ borderBottom: '2px solid var(--color-divider)' }}
                  data-testid={`coverage-${g.hotelId}-${g.deptId}`}
                >
                  <div
                    style={{ padding: '5px var(--space-4)', fontSize: 11, color: 'var(--color-neutral-700)' }}
                  >
                    {t('Besetzung · min.')}{' '}
                    {Math.max(
                      ...data.coverage
                        .filter((c) => c.hotelId === g.hotelId && c.departmentId === g.deptId)
                        .map((c) => c.required),
                    )}
                  </div>
                  {data.days.map((d) => {
                    const c = dayCoverage(g, d.date);
                    return (
                      <div
                        key={d.date}
                        style={{
                          borderLeft: '1px solid var(--color-divider)',
                          padding: '5px 8px',
                          fontSize: 12,
                          fontVariantNumeric: 'tabular-nums',
                          ...(c?.underStaffed ? { fontWeight: 800, color: 'var(--warn)' } : {}),
                        }}
                      >
                        {c ? `${c.assigned}/${c.required}` : ''}
                        {c?.underStaffed && <span> {t('zu wenig')}</span>}
                      </div>
                    );
                  })}
                  <div style={{ borderLeft: '1px solid var(--color-divider)' }} />
                </div>
              )}
          </div>
        ))}
      </div>
      {menu && <CellMenu target={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
