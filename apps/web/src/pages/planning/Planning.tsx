import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { api, ApiError, download, useGet } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fnum } from '../../lib/format';
import { Segmented, useToast } from '../../components/ui';
import { MultiSelect } from './Dropdown';
import { PlanContext, PlanGrid, WarnIcon, type PlanCtx } from './Grid';
import { SidePanel } from './Panel';
import { ClearDialog, FinderDialog, ReasonDialog, type ReasonState } from './Dialogs';
import type { DropState, GridData, GridEntry, GridRow, PlanOp, Sel, ShiftTpl } from './types';
import {
  OVERRIDABLE,
  addDaysIso,
  dayNum,
  hmTz,
  isoWeekNo,
  mondayOfIso,
  todayIso,
  violationText,
  weekRangeLabel,
  type Violation,
} from './util';
import './planning.css';

const LS = 'pl.filters';
const loadLs = (): { hotels?: number[]; depts?: string[]; view?: string } => {
  try {
    return JSON.parse(localStorage.getItem(LS) ?? '{}');
  } catch {
    return {};
  }
};

function PaletteItem({ shift, label }: { shift: ShiftTpl; label: string }) {
  const d = useDraggable({ id: `tpl:${shift.id}`, data: { type: 'tpl', shift } });
  return (
    <span
      ref={d.setNodeRef}
      className="pl-pal"
      {...d.listeners}
      {...d.attributes}
      data-testid={`pal-${shift.id}`}
      style={{ opacity: d.isDragging ? 0.4 : 1 }}
    >
      {label}
    </span>
  );
}
function PaletteFree() {
  const { t } = useTranslation();
  const d = useDraggable({ id: 'abs:off_day', data: { type: 'abs', absence: 'off_day' } });
  return (
    <span
      ref={d.setNodeRef}
      className="pl-pal"
      {...d.listeners}
      {...d.attributes}
      style={{ opacity: d.isDragging ? 0.4 : 1 }}
    >
      {t('Frei')}
    </span>
  );
}
function Trash() {
  const { t } = useTranslation();
  const d = useDroppable({ id: 'trash', data: { type: 'trash' } });
  return (
    <span ref={d.setNodeRef} className={`pl-trash ${d.isOver ? 'over' : ''}`} data-testid="trash">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        aria-hidden
      >
        <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
      </svg>
      {t('Zum Löschen hierher ziehen')}
    </span>
  );
}

export function Planning() {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const { me } = useAuth();
  const [params, setParams] = useSearchParams();
  const today = todayIso();
  const weekStart = mondayOfIso(params.get('week') ?? today);
  const hotelsQ = useGet('/hotels');
  const deptsQ = useGet('/departments');
  const shiftsQ = useGet('/shifts');
  const empsQ = useGet('/employees', { pageSize: 200 });
  const hotels: any[] = useMemo(() => hotelsQ.data?.items ?? [], [hotelsQ.data]);
  const depts: any[] = useMemo(() => deptsQ.data?.items ?? [], [deptsQ.data]);
  const shifts: ShiftTpl[] = useMemo(() => shiftsQ.data?.items ?? [], [shiftsQ.data]);

  const saved = useMemo(loadLs, []);
  const [hotelSel, setHotelSel] = useState<number[] | null>(saved.hotels ?? null);
  const [deptSel, setDeptSel] = useState<string[] | null>(saved.depts ?? null);
  const [view, setView] = useState<'employee' | 'shift'>(saved.view === 'shift' ? 'shift' : 'employee');
  const hotelIds = (hotelSel ?? hotels.map((h) => h.id)).filter((id) => hotels.some((h) => h.id === id));
  const deptNames = useMemo(() => [...new Set(depts.map((d) => d.name as string))], [depts]);
  const deptActive = deptSel ?? deptNames;
  const departmentIds =
    deptActive.length === deptNames.length
      ? undefined
      : depts.filter((d) => deptActive.includes(d.name) && hotelIds.includes(d.hotelId)).map((d) => d.id);
  useEffect(() => {
    try {
      localStorage.setItem(LS, JSON.stringify({ hotels: hotelSel, depts: deptSel, view }));
    } catch {
      /* ignore */
    }
  }, [hotelSel, deptSel, view]);

  const gridKey = ['grid', hotelIds, departmentIds, view, weekStart];
  const grid = useQuery<GridData>({
    queryKey: gridKey,
    queryFn: () =>
      api('/schedule/grid', { query: { hotelIds, departmentIds, view, range: 'week', from: weekStart } }),
    enabled: hotelIds.length > 0,
    placeholderData: (prev) => prev,
  });
  const data = grid.data;
  const refetch = useCallback(() => qc.invalidateQueries({ queryKey: ['grid'] }), [qc]);

  const [sel, setSel] = useState<Sel>(null);
  const [range, setRange] = useState<PlanCtx['range']>(null);
  const [reason, setReason] = useState<ReasonState | null>(null);
  const [conflict, setConflict] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [finder, setFinder] = useState<{ entry: GridEntry; row: GridRow } | null>(null);
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const [dropState, setDropState] = useState<Record<string, DropState>>({});
  const [dragging, setDragging] = useState(false);
  const altRef = useRef(false);
  const cache = useRef(new Map<string, DropState>());
  const canEmergency = me?.role === 'admin' || me?.role === 'superAdmin';

  // ---- run an operation with the SPEC 4.3 reason / emergency flows
  const exec = useCallback(
    async (op: PlanOp, extra: Record<string, unknown> = {}): Promise<boolean> => {
      try {
        const body = op.method === 'DELETE' ? undefined : { ...(op.body ?? {}), ...extra };
        const res = await api(op.path, { method: op.method, body });
        setConflict(false);
        await refetch();
        void qc.invalidateQueries({ queryKey: ['api'] });
        if (op.path === '/schedule/copy-week')
          toast(
            `${res.created} ${t('Einträge als Entwurf übernommen.')}${res.skipped?.length ? ` ${res.skipped.length} ${t('übersprungen')}.` : ''}`,
          );
        else if (op.path === '/schedule/clear-week') toast(t('Plan geleert.'));
        else if (op.done) toast(t(op.done));
        return true;
      } catch (e) {
        const err = e as ApiError;
        const vs: Violation[] = err.details?.violations ?? [];
        if (err.code === 'REASON_REQUIRED') {
          setReason({
            violations: vs,
            emergency: false,
            retry: (r, em) =>
              void exec(op, { overrideReason: r, ...(em ? { emergencyOverride: true } : {}) }),
          });
        } else if (
          err.code === 'RULE_BLOCKED' &&
          canEmergency &&
          vs.filter((v) => v.severity === 'block').every((v) => OVERRIDABLE.has(v.code)) &&
          vs.length > 0 &&
          op.path.startsWith('/schedule/') &&
          !op.path.includes('absence')
        ) {
          setReason({
            violations: vs,
            emergency: true,
            retry: (r, em) =>
              void exec(op, { overrideReason: r, ...(em ? { emergencyOverride: true } : {}) }),
          });
        } else if (err.code === 'VERSION_CONFLICT') {
          setConflict(true);
          void refetch();
        } else if (vs.length) {
          const x = violationText(vs[0], t);
          toast(`${x.title}: ${x.msg}`);
        } else toast(err.message);
        return false;
      }
    },
    [canEmergency, qc, refetch, t, toast],
  );
  const run = useCallback(
    async (op: PlanOp | PlanOp[]) => {
      for (const o of Array.isArray(op) ? op : [op]) if (!(await exec(o))) return false;
      return true;
    },
    [exec],
  );

  // ---- drag and drop
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      altRef.current = e.altKey;
    };
    window.addEventListener('keydown', k);
    window.addEventListener('keyup', k);
    return () => {
      window.removeEventListener('keydown', k);
      window.removeEventListener('keyup', k);
    };
  }, []);

  type DragSpec = { op: PlanOp; validate: Record<string, any> };
  const specFor = useCallback((a: any, o: any, alt: boolean): DragSpec | null => {
    if (!a || !o) return null;
    if (a.type === 'entry') {
      const e: GridEntry = a.entry;
      if (o.type === 'trash')
        return {
          op: {
            method: 'DELETE',
            path: `/schedule/entries/${e.id}?version=${e.version}`,
            done: 'Eintrag entfernt.',
          },
          validate: { operation: 'delete', entryId: e.id, version: e.version },
        };
      if (o.type === 'chip') {
        const b: GridEntry = o.entry;
        if (b.id === e.id || b.isOtherHotel) return null;
        const body = { entryAId: e.id, versionA: e.version, entryBId: b.id, versionB: b.version };
        return {
          op: { method: 'POST', path: '/schedule/swap', body, done: 'Einträge getauscht.' },
          validate: { operation: 'swap', ...body },
        };
      }
      if (o.type === 'cell') {
        const row: GridRow = o.row;
        const date: string = o.cell.date;
        const body: Record<string, any> = { entryId: e.id, toDate: date };
        if (row.kind === 'employee') {
          if (row.employeeId === e.employeeId && date === e.date) return null;
          body.toEmployeeId = row.employeeId;
        } else {
          if (!row.shiftId || (row.shiftId === e.shiftId && date === e.date)) return null;
          body.toShiftId = row.shiftId;
        }
        if (alt)
          return {
            op: { method: 'POST', path: '/schedule/copy', body, done: 'Eintrag kopiert.' },
            validate: { operation: 'copy', ...body },
          };
        const mv = { ...body, version: e.version };
        return {
          op: { method: 'POST', path: '/schedule/move', body: mv, done: 'Eintrag verschoben.' },
          validate: { operation: 'move', ...mv },
        };
      }
    }
    if (a.type === 'tpl' && o.type === 'cell' && o.row.kind === 'employee') {
      const s: ShiftTpl = a.shift;
      const body = { hotelId: s.hotelId, employeeId: o.row.employeeId, shiftId: s.id, date: o.cell.date };
      return {
        op: { method: 'POST', path: '/schedule/entries', body, done: 'Eintrag gespeichert.' },
        validate: { operation: 'create', ...body },
      };
    }
    if (a.type === 'abs' && o.type === 'cell' && o.row.kind === 'employee') {
      const body = { employeeId: o.row.employeeId, from: o.cell.date, to: o.cell.date, type: a.absence };
      return {
        op: { method: 'POST', path: '/schedule/absence', body, done: 'Abwesenheit eingetragen.' },
        validate: { operation: 'absence', ...body },
      };
    }
    return null;
  }, []);

  const onDragStart = (e: DragStartEvent) => {
    setDragging(true);
    cache.current.clear();
    const d = e.active.data.current as any;
    setDragLabel(
      d?.type === 'entry'
        ? d.entry.displayName
        : d?.type === 'tpl'
          ? `${d.shift.name} ${d.shift.startTime}–${d.shift.endTime}`
          : t('Frei'),
    );
    altRef.current = !!(e.activatorEvent as MouseEvent | undefined)?.altKey;
  };
  const onDragOver = async (e: DragOverEvent) => {
    const overId = e.over?.id as string | undefined;
    if (!overId) return setDropState({});
    const spec = specFor(e.active.data.current, e.over?.data.current, altRef.current);
    if (!spec) return setDropState({ [overId]: 'blocked' });
    if (overId === 'trash') return setDropState({});
    const key = JSON.stringify(spec.validate);
    const hit = cache.current.get(key);
    if (hit) return setDropState({ [overId]: hit });
    setDropState({ [overId]: 'pending' });
    try {
      const r = await api('/schedule/validate', { method: 'POST', body: spec.validate });
      const st: DropState =
        r.status === 'ok' ? 'ok' : r.status === 'needs_reason' ? 'needs_reason' : 'blocked';
      cache.current.set(key, st);
      setDropState((cur) => (overId in cur ? { [overId]: st } : cur));
    } catch {
      setDropState((cur) => (overId in cur ? { [overId]: 'blocked' } : cur));
    }
  };
  const endDrag = () => {
    setDragging(false);
    setDragLabel(null);
    setDropState({});
  };
  const onDragEnd = (e: DragEndEvent) => {
    const spec = specFor(e.active.data.current, e.over?.data.current, altRef.current);
    endDrag();
    if (spec) void exec(spec.op);
  };

  // ---- derived
  const ctx: PlanCtx | null = data
    ? { data, shifts, sel, setSel, drop: dropState, dragging, run, range, setRange, today }
    : null;
  const viewShifts = shifts.filter(
    (s) => hotelIds.includes(s.hotelId) && (!departmentIds || departmentIds.includes(s.departmentId)),
  );
  const hotelName = (id: number) => hotels.find((h) => h.id === id)?.name ?? '';
  const empItems: any[] = empsQ.data?.items ?? [];
  const hotelOpts = hotels.map((h) => ({
    id: String(h.id),
    label: h.name,
    count: empItems.filter((e) => e.homeHotel.id === h.id).length,
  }));
  const deptOpts = deptNames.map((n) => ({
    id: n,
    label: n,
    count: empItems.filter((e) => e.department.name === n).length,
  }));

  const changes = data?.changes ?? [];
  const nDrafts = data?.counts.drafts ?? 0;
  const toPublish = Math.max(nDrafts, changes.length);
  const to = data?.to ?? addDaysIso(weekStart, 6);
  const weekChip =
    to < today
      ? t('Vergangen · gesperrt')
      : weekStart <= today
        ? t('Aktuelle Woche')
        : weekStart === addDaysIso(mondayOfIso(today), 7)
          ? t('Kommende Woche')
          : '';
  const setWeek = (w: string) =>
    setParams(
      (p) => {
        p.set('week', w);
        return p;
      },
      { replace: true },
    );
  const weekOpts = useMemo(() => {
    const cur = mondayOfIso(today);
    return Array.from({ length: 14 }, (_, i) => addDaysIso(cur, (i - 3) * 7));
  }, [today]);
  const live = (data?.rows ?? [])
    .flatMap((r) => r.cells)
    .flatMap((c) => c.entries.map((e) => ({ e, locked: c.locked })))
    .filter(({ e, locked }) => !locked && !e.isOtherHotel && e.change !== 'removed');
  const uniqLive = [...new Map(live.map((x) => [x.e.id, x.e])).values()];

  const publish = async () => {
    if (!data) return;
    const ok = await exec({
      method: 'POST',
      path: '/schedule/publish',
      body: { hotelIds: data.hotelIds, from: data.from, to: data.to },
    });
    if (ok)
      toast(
        `${t('Woche veröffentlicht. Mitarbeitende und das Rezeptions-Tablet sehen jetzt')} ${weekRangeLabel(data.from, data.to)}`,
      );
  };
  const copyPrev = () =>
    data &&
    void exec({
      method: 'POST',
      path: '/schedule/copy-week',
      body: {
        hotelIds: data.hotelIds,
        departmentIds,
        fromWeek: addDaysIso(weekStart, -7),
        toWeek: weekStart,
      },
    });
  const revertAll = () =>
    data &&
    void exec({
      method: 'POST',
      path: '/schedule/revert',
      body: { hotelIds: data.hotelIds, from: data.from, to: data.to },
      done: 'Änderungen verworfen.',
    });

  return (
    <main
      className="pl-main-grid"
      data-printmain
      style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 330px', flex: 1, minHeight: 0 }}
    >
      <section style={{ minWidth: 0, borderRight: '2px solid var(--color-divider)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
            padding: 'var(--space-4) var(--space-4) var(--space-2)',
          }}
        >
          <div style={{ marginRight: 'auto' }}>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <span
                style={{
                  fontSize: 11,
                  letterSpacing: '.1em',
                  textTransform: 'uppercase',
                  color: 'var(--color-accent-700)',
                }}
              >
                KW {isoWeekNo(weekStart)} · {hotelIds.map(hotelName).join(' + ')}
              </span>
              {weekChip && <span className="tag tag-neutral">{weekChip}</span>}
              {data && (
                <span className="tag tag-neutral" data-testid="week-status">
                  {data.status === 'published' ? t('Veröffentlicht') : t('Entwurf')}
                </span>
              )}
            </div>
            <h1 style={{ margin: '2px 0 0', fontSize: 30, lineHeight: 1.1 }}>
              {weekRangeLabel(weekStart, addDaysIso(weekStart, 6))}
            </h1>
            <div data-printonly style={{ display: 'none', fontSize: 12, marginTop: 4 }}>
              {t('Hotels')}: {hotelIds.map(hotelName).join(', ')} · {t('Ansicht')}:{' '}
              {view === 'employee' ? t('Nach Mitarbeiter') : t('Nach Dienst')}
            </div>
          </div>
          <div data-noprint style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <button
              className="btn btn-secondary btn-icon"
              onClick={() => setWeek(addDaysIso(weekStart, -7))}
              aria-label={t('Vorherige Woche')}
              data-testid="prev-week"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
              >
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <button className="btn btn-secondary" onClick={() => setWeek(mondayOfIso(today))}>
              {t('Heute')}
            </button>
            <button
              className="btn btn-secondary btn-icon"
              onClick={() => setWeek(addDaysIso(weekStart, 7))}
              aria-label={t('Nächste Woche')}
              data-testid="next-week"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
            <button
              className="btn btn-secondary"
              style={{ marginLeft: 'var(--space-2)' }}
              onClick={() => window.print()}
            >
              {t('Dienstplan als PDF')}
            </button>
            <button
              className="btn btn-secondary"
              style={{ marginLeft: 'var(--space-2)' }}
              data-testid="export-xlsx"
              onClick={() =>
                void download(
                  '/schedule/export',
                  { hotelIds, departmentIds, view, range: 'week', from: weekStart, format: 'xlsx' },
                  `dienstplan_${weekStart}.xlsx`,
                ).catch(() => toast(t('Export fehlgeschlagen')))
              }
            >
              {t('Als Excel exportieren')}
            </button>
            <select
              className="input"
              style={{ width: 'auto', minHeight: 36, marginLeft: 'var(--space-2)' }}
              aria-label={t('Woche')}
              value={weekStart}
              onChange={(e) => setWeek(e.target.value)}
            >
              {(weekOpts.includes(weekStart) ? weekOpts : [weekStart, ...weekOpts]).map((w) => (
                <option key={w} value={w}>
                  KW {isoWeekNo(w)} · {dayNum(w)}.{w.slice(5, 7)}.–{dayNum(addDaysIso(w, 6))}.
                  {addDaysIso(w, 6).slice(5, 7)}.{w === mondayOfIso(today) ? ` · ${t('aktuell')}` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div
          data-noprint
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
            alignItems: 'center',
            padding: '0 var(--space-4) var(--space-3)',
          }}
        >
          <Segmented
            value={view}
            onChange={setView}
            label={t('Ansicht')}
            options={[
              { value: 'employee', label: t('Nach Mitarbeiter') },
              { value: 'shift', label: t('Nach Dienst') },
            ]}
          />
          <MultiSelect
            label={t('Hotels')}
            allLabel={t('Alle Hotels')}
            options={hotelOpts}
            value={hotelIds.map(String)}
            onChange={(v) => setHotelSel(v.map(Number))}
          />
          <MultiSelect
            label={t('Abteilungen')}
            allLabel={t('Alle Abteilungen')}
            options={deptOpts}
            value={deptActive}
            onChange={setDeptSel}
          />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={copyPrev} data-testid="copy-prev">
              {t('Vorwoche kopieren')}
            </button>
            <button className="btn btn-secondary" onClick={() => setClearOpen(true)} data-testid="clear-plan">
              {t('Plan leeren')}
            </button>
            {toPublish > 0 ? (
              <button className="btn btn-primary" onClick={() => void publish()} data-testid="publish">
                {toPublish} {toPublish === 1 ? t('Entwurf veröffentlichen') : t('Entwürfe veröffentlichen')}
              </button>
            ) : (
              <span className="tag tag-neutral" style={{ padding: '8px 12px' }}>
                {t('Alles veröffentlicht')}
              </span>
            )}
          </div>
        </div>
        {conflict && (
          <div
            role="alert"
            data-noprint
            style={{
              margin: '0 var(--space-4) var(--space-3)',
              border: '2px solid var(--warn)',
              padding: '8px 12px',
              fontSize: 13,
              fontWeight: 600,
              display: 'flex',
              gap: 12,
              alignItems: 'center',
            }}
          >
            {t('Der Plan wurde zwischenzeitlich von jemand anderem geändert. Er wurde neu geladen.')}
            <button className="btn btn-secondary" onClick={() => setConflict(false)}>
              {t('OK')}
            </button>
          </div>
        )}
        {changes.length > 0 && (
          <div
            data-noprint
            style={{ margin: '0 var(--space-4) var(--space-3)', border: '2px solid var(--color-divider)' }}
            data-testid="changes-panel"
          >
            <div
              style={{
                display: 'flex',
                gap: 'var(--space-2)',
                alignItems: 'center',
                padding: '4px 12px',
                background: 'var(--color-surface)',
                borderBottom: '1px solid var(--color-divider)',
              }}
            >
              <b style={{ fontSize: 13, marginRight: 'auto' }}>
                {t('Änderungen seit der letzten Veröffentlichung')}
              </b>
              <button className="btn btn-ghost" onClick={revertAll}>
                {t('Alle verwerfen')}
              </button>
            </div>
            <div style={{ maxHeight: 120, overflow: 'auto' }}>
              {changes.map((c) => (
                <button
                  key={c.entryId}
                  onClick={() => setSel({ kind: 'entry', id: c.entryId })}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '120px 80px minmax(0,1fr) 80px',
                    gap: 'var(--space-2)',
                    width: '100%',
                    textAlign: 'left',
                    padding: '5px 12px',
                    border: 0,
                    borderBottom: '1px solid var(--color-divider)',
                    background: 'transparent',
                    cursor: 'pointer',
                    fontSize: 13,
                    color: 'var(--color-text)',
                  }}
                >
                  <b>{c.displayName}</b>
                  <span
                    className={`tag ${c.type === 'removed' ? 'tag-outline' : c.type === 'changed' ? 'tag-accent' : 'tag-neutral'}`}
                    style={{ justifySelf: 'start' }}
                  >
                    {t(c.type === 'new' ? 'Neu' : c.type === 'changed' ? 'Geändert' : 'Entfernt')}
                  </span>
                  <span>
                    {c.type === 'changed' && c.from
                      ? `${c.from.date.slice(8)}.${c.from.date.slice(5, 7)}. ${hmTz(c.from.start)}–${hmTz(c.from.end)} → `
                      : ''}
                    {c.to
                      ? `${c.to.date.slice(8)}.${c.to.date.slice(5, 7)}. ${hmTz(c.to.start)}–${hmTz(c.to.end)}`
                      : c.from
                        ? `${hmTz(c.from.start)}–${hmTz(c.from.end)}`
                        : ''}
                  </span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {c.date.slice(8)}.{c.date.slice(5, 7)}.
                  </span>
                </button>
              ))}
            </div>
            <div style={{ padding: '5px 12px', fontSize: 12, color: 'var(--color-neutral-800)' }}>
              {t('Mitarbeitende mit veröffentlichten Schichten werden beim Veröffentlichen benachrichtigt.')}
            </div>
          </div>
        )}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4,minmax(0,1fr))',
            borderTop: '2px solid var(--color-divider)',
          }}
          data-testid="counters"
        >
          {[
            [data?.counts.drafts ?? 0, 'Änderungen', 'drafts'],
            [data?.counts.warnings ?? 0, 'Warnungen', 'warnings'],
            [data?.counts.underStaffed ?? 0, 'Unterbesetzt', 'under'],
            [data?.counts.openRequests ?? 0, 'Offene Anträge', 'requests'],
          ].map(([n, l, k]) => (
            <div
              key={k as string}
              style={{
                padding: '8px var(--space-4)',
                borderRight: '1px solid var(--color-divider)',
                display: 'flex',
                alignItems: 'baseline',
                gap: 'var(--space-2)',
              }}
            >
              <span
                data-testid={`count-${k}`}
                style={{
                  fontSize: 28,
                  fontWeight: 800,
                  lineHeight: 1,
                  fontVariantNumeric: 'tabular-nums',
                  color: k === 'under' && (n as number) > 0 ? 'var(--warn)' : undefined,
                }}
              >
                {n}
              </span>
              <span style={{ fontSize: 12, color: 'var(--color-neutral-800)' }}>{t(l as string)}</span>
            </div>
          ))}
        </div>
        <DndContext
          sensors={sensors}
          collisionDetection={(args) => {
            const hits = pointerWithin(args);
            return hits.sort((a, b) => rank(a.id) - rank(b.id));
          }}
          onDragStart={onDragStart}
          onDragOver={(e) => void onDragOver(e)}
          onDragEnd={onDragEnd}
          onDragCancel={endDrag}
        >
          <div
            data-noprint
            style={{
              display: 'flex',
              gap: 'var(--space-2)',
              alignItems: 'center',
              flexWrap: 'wrap',
              padding: '8px var(--space-4)',
              borderTop: '1px solid var(--color-divider)',
              background: 'var(--color-surface)',
            }}
          >
            {view === 'employee' && (
              <span style={{ fontSize: 12, fontWeight: 700 }}>{t('Schicht ziehen')}</span>
            )}
            {view === 'employee' &&
              viewShifts.map((s) => (
                <PaletteItem
                  key={s.id}
                  shift={s}
                  label={`${s.name} ${s.startTime.replace(':00', '')}–${s.endTime.replace(':00', '')}${hotelIds.length > 1 ? ` · ${hotelName(s.hotelId).slice(0, 3)}` : ''}`}
                />
              ))}
            {view === 'employee' && <PaletteFree />}
            <Trash />
          </div>
          <div
            data-noprint
            style={{
              display: 'flex',
              gap: 'var(--space-4)',
              flexWrap: 'wrap',
              padding: '8px var(--space-4)',
              borderTop: '1px solid var(--color-divider)',
              fontSize: 12,
              color: 'var(--color-neutral-700)',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 14, height: 14, background: 'var(--color-neutral-300)' }} />
              {t('Veröffentlicht')}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 12, height: 12, border: '1px dashed var(--color-text)' }} />
              {t('Entwurf')}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  width: 14,
                  height: 14,
                  background:
                    'repeating-linear-gradient(135deg,var(--color-neutral-300) 0 3px,transparent 3px 6px)',
                }}
              />
              {t('Abwesenheit')}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--warn)' }}>
              <WarnIcon size={14} />
              {t('Warnung')}
            </span>
          </div>
          {ctx ? (
            <PlanContext.Provider value={ctx}>
              <PlanGrid />
            </PlanContext.Provider>
          ) : (
            <div style={{ padding: 'var(--space-8) var(--space-4)' }}>
              {hotelIds.length === 0 && hotels.length > 0
                ? t('Keine Hotels oder Abteilungen ausgewählt. Wähle oben mindestens eines aus.')
                : '…'}
            </div>
          )}
          <DragOverlay dropAnimation={null}>
            {dragLabel && <div className="pl-overlay">{dragLabel}</div>}
          </DragOverlay>
        </DndContext>
      </section>
      <aside
        className="pl-aside"
        data-noprint
        style={{
          padding: 'var(--space-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
          minWidth: 0,
        }}
      >
        {ctx && <SidePanel ctx={ctx} onFinder={(entry, row) => setFinder({ entry, row })} />}
      </aside>
      {reason && <ReasonDialog state={reason} onClose={() => setReason(null)} />}
      {clearOpen && (
        <ClearDialog
          n={uniqLive.length}
          pub={uniqLive.filter((e) => e.status === 'published').length}
          onConfirm={() =>
            data &&
            void exec({
              method: 'POST',
              path: '/schedule/clear-week',
              body: { hotelIds: data.hotelIds, from: data.from, to: data.to },
            })
          }
          onClose={() => setClearOpen(false)}
        />
      )}
      {finder && (
        <FinderDialog
          entry={finder.entry}
          row={finder.row}
          onClose={() => setFinder(null)}
          onAssign={(id) =>
            void exec({
              method: 'POST',
              path: '/schedule/move',
              body: { entryId: finder.entry.id, version: finder.entry.version, toEmployeeId: id },
              done: 'Vertretung eingetragen.',
            })
          }
        />
      )}
    </main>
  );
}

const rank = (id: string | number) => (String(id) === 'trash' ? 0 : String(id).startsWith('chip:') ? 1 : 2);
void fnum;
