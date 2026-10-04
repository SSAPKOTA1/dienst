import {
  addDays,
  countedDays,
  eachDay,
  isMinor,
  mondayOf,
  openSlots as openSlotsFn,
  workingMinutes,
  type Violation,
} from '@dienst/rules';
import type { Db } from '../../db';
import { isoWithOffset } from '../../lib/time';
import type { Principal } from '../../lib/scope';
import { resolveHolidayRows } from '../holidays';
import { loadStaffing, requiredOn } from '../staffing';
import { changesInRange, latestSnapshot, type Change } from './changes';
import { PlanEnv, type EntryRow, type PlanEmployee } from './env';
import { hoursOf } from './ops';

export interface GridParams {
  hotelIds: number[];
  departmentIds?: number[];
  view: 'employee' | 'shift';
  range: 'week' | 'month';
  from: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function rangeOf(range: 'week' | 'month', from: string): { from: string; to: string } {
  if (range === 'week') {
    const m = mondayOf(from);
    return { from: m, to: addDays(m, 6) };
  }
  const first = `${from.slice(0, 7)}-01`;
  const [y, m] = first.split('-').map(Number);
  return { from: first, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

export async function buildGrid(db: Db, p: Principal, now: Date, prm: GridParams) {
  const hotelIds = p.scope.hotels(prm.hotelIds);
  const { from, to } = rangeOf(prm.range, prm.from);
  const dates = eachDay(from, to);
  const empty = {
    hotelIds,
    view: prm.view,
    range: prm.range,
    from,
    to,
    status: 'draft',
    days: dates.map((date) => ({ date, holiday: null, past: false, closedHotelIds: [] as number[] })),
    rows: [],
    absences: [],
    totals: { perDay: [] },
    changes: [],
    counts: { drafts: 0, warnings: 0, underStaffed: 0, openRequests: 0 },
    coverage: [],
  };
  if (!hotelIds.length) return empty;

  const hotels = await db
    .selectFrom('hotel')
    .select(['id', 'name', 'company_id'])
    .where('id', 'in', hotelIds)
    .orderBy('id')
    .execute();
  const allDepts = await db
    .selectFrom('department')
    .selectAll()
    .where('hotel_id', 'in', hotelIds)
    .orderBy('hotel_id')
    .orderBy('id')
    .execute();
  const depts = prm.departmentIds?.length
    ? allDepts.filter((d) => prm.departmentIds!.includes(d.id))
    : allDepts;
  const deptIds = new Set(depts.map((d) => d.id));
  const shifts = (
    await db
      .selectFrom('shift')
      .selectAll()
      .where('hotel_id', 'in', hotelIds)
      .orderBy('hotel_id')
      .orderBy('department_id')
      .orderBy('start_time')
      .orderBy('id')
      .execute()
  ).filter((s) => deptIds.has(s.department_id));
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const staffing = await loadStaffing(
    db,
    shifts.map((s) => s.id),
  );

  // ---- entries of the selected hotels
  const rawRows = (await db
    .selectFrom('schedule')
    .selectAll()
    .where('hotel_id', 'in', hotelIds)
    .where('shift_date', '>=', from)
    .where('shift_date', '<=', to)
    .orderBy('id')
    .execute()) as EntryRow[];

  // ---- employees
  const empHotel = await db
    .selectFrom('employee_hotel as eh')
    .innerJoin('employee as e', 'e.employee_id', 'eh.employee_id')
    .select(['e.employee_id', 'e.status'])
    .where('eh.hotel_id', 'in', hotelIds)
    .execute();
  const empDept = deptIds.size
    ? await db
        .selectFrom('employee_department')
        .select(['employee_id', 'department_id'])
        .where('department_id', 'in', [...deptIds])
        .execute()
    : [];
  const inDept = new Set(empDept.map((e) => e.employee_id));
  const candidateIds = new Set(
    empHotel.filter((e) => e.status === 'active' && inDept.has(e.employee_id)).map((e) => e.employee_id),
  );
  for (const r of rawRows) candidateIds.add(r.employee_id);
  const absRows = candidateIds.size
    ? await db
        .selectFrom('time_off')
        .selectAll()
        .where('employee_id', 'in', [...candidateIds])
        .where('status', 'in', ['approved', 'pending'])
        .where('end_date', '>=', from)
        .where('start_date', '<=', to)
        .execute()
    : [];
  const env = await PlanEnv.create(db, now, { employeeIds: [...candidateIds], from, to });
  const emps = [...env.employees.values()];

  // entries that belong to the department filter
  const entryVisible = (r: EntryRow) => {
    if (r.shift_id) return shiftById.has(r.shift_id);
    const e = env.employees.get(r.employee_id);
    return !!e && (!prm.departmentIds?.length || e.departmentIds.some((d) => deptIds.has(d)));
  };

  const changes = await changesInRange(db, hotelIds, from, to);
  const changeOf = new Map<number, Change>(changes.map((c) => [c.entryId, c]));

  // ---- warnings per live entry
  const warningsOf = new Map<number, Violation[]>();
  const live = rawRows.filter((r) => r.status !== 'cancelled' && entryVisible(r));
  for (const r of live) {
    if (r.shift_date < env.today(r.hotel_id)) continue; // past days are locked, warnings only matter from today on
    const shift = r.shift_id ? shiftById.get(r.shift_id) : undefined;
    const v = env.check(
      {
        employeeId: r.employee_id,
        hotelId: r.hotel_id,
        shiftId: r.shift_id,
        departmentId: shift?.department_id ?? null,
        startMs: r.planned_start.getTime(),
        endMs: r.planned_end.getTime(),
        breakMinutes: r.planned_break_minutes,
        ignoreIds: [r.id],
        entryId: r.id,
      },
      [],
      ['PAST_DAY', 'PERIOD_CLOSED'],
    );
    if (v.length) warningsOf.set(r.id, v);
  }

  const entryOut = (r: EntryRow, extra: Record<string, unknown> = {}) => {
    const emp = env.employees.get(r.employee_id);
    const tz = env.hotel(r.hotel_id).tz;
    const shift = r.shift_id ? shiftById.get(r.shift_id) : undefined;
    const homeOut = emp && p.role === 'manager' && !p.scope.canHotel(emp.primaryHotelId);
    return {
      id: r.id,
      version: r.version,
      hotelId: r.hotel_id,
      employeeId: r.employee_id,
      displayName: emp?.displayName ?? '',
      shiftId: r.shift_id,
      shiftName: shift?.name ?? null,
      departmentId: shift?.department_id ?? null,
      date: r.shift_date,
      start: isoWithOffset(r.planned_start, tz),
      end: isoWithOffset(r.planned_end, tz),
      breakMinutes: r.planned_break_minutes,
      hours: hoursOf({
        startMs: r.planned_start.getTime(),
        endMs: r.planned_end.getTime(),
        breakMinutes: r.planned_break_minutes,
      }),
      status: r.status,
      change: changeOf.get(r.id)?.type ?? null,
      warnings: (warningsOf.get(r.id) ?? []).map((v) => ({
        code: v.code,
        severity: v.severity,
        message: v.message,
        details: v.details,
      })),
      isOtherHotel: !!emp && !hotelIds.includes(emp.primaryHotelId),
      homeHotel: emp
        ? { id: emp.primaryHotelId, name: env.hotels.get(emp.primaryHotelId)?.name ?? '' }
        : null,
      reducedHome: !!homeOut,
      ...extra,
    };
  };

  const liveEntries = live;
  // ghosts of removed (cancelled) entries shown until the next publication
  const ghosts = rawRows.filter(
    (r) => r.status === 'cancelled' && changeOf.get(r.id)?.type === 'removed' && entryVisible(r),
  );

  // ---- days
  const tz0 = env.hotel(hotelIds[0]).tz;
  void tz0;
  const hol = await resolveHolidayRows(db, hotelIds[0], from, to);
  const days = dates.map((date) => ({
    date,
    holiday: hol.get(date)?.name ?? null,
    past: date < env.today(hotelIds[0]),
    closedHotelIds: hotelIds.filter((h) => env.isClosed(h, date)),
  }));

  // ---- absences (reduced view for managers of other hotels)
  const visibleEmp = (e: PlanEmployee) => !(p.role === 'manager' && !p.scope.canHotel(e.primaryHotelId));
  const absences = absRows
    .filter((a) => env.employees.has(a.employee_id))
    .map((a) => {
      const e = env.employees.get(a.employee_id)!;
      return {
        id: a.id,
        employeeId: a.employee_id,
        displayName: e.displayName,
        type: visibleEmp(e) ? a.type : 'absent',
        from: a.start_date < from ? from : a.start_date,
        to: a.end_date > to ? to : a.end_date,
        status: a.status as string,
        days: a.time_off_days,
      };
    });

  // ---- coverage per department and day
  const coverage: Array<{
    hotelId: number;
    departmentId: number;
    departmentName: string;
    date: string;
    assigned: number;
    required: number;
    underStaffed: boolean;
  }> = [];
  for (const d of depts) {
    const dShifts = shifts.filter((s) => s.department_id === d.id);
    if (!dShifts.length) continue;
    for (const date of dates) {
      const required = dShifts.reduce((a, s) => a + requiredOn(staffing.get(s.id), date), 0);
      const assigned = new Set(
        liveEntries
          .filter((r) => r.shift_date === date && r.shift_id && dShifts.some((s) => s.id === r.shift_id))
          .map((r) => r.employee_id),
      ).size;
      coverage.push({
        hotelId: d.hotel_id,
        departmentId: d.id,
        departmentName: d.name,
        date,
        assigned,
        required,
        underStaffed: assigned < required,
      });
    }
  }

  // ---- rows
  const rows: any[] = [];
  const cellLock = (date: string, hotelId?: number): 'past' | 'closed' | null => {
    const h = hotelId ?? hotelIds[0];
    return date < env.today(h) ? 'past' : env.isClosed(h, date) ? 'closed' : null;
  };

  if (prm.view === 'employee') {
    const primaryGroup = (e: PlanEmployee) => {
      const mine = depts.filter((d) => e.departmentIds.includes(d.id) || d.id === e.primaryDepartmentId);
      return mine.find((d) => d.id === e.primaryDepartmentId) ?? mine[0] ?? depts[0];
    };
    const hotelOrder = new Map(hotels.map((h, i) => [h.id, i]));
    const sorted = [...emps].sort((a, b) => {
      const ga = primaryGroup(a);
      const gb = primaryGroup(b);
      return (
        (hotelOrder.get(ga?.hotel_id ?? 0) ?? 0) - (hotelOrder.get(gb?.hotel_id ?? 0) ?? 0) ||
        (ga?.id ?? 0) - (gb?.id ?? 0) ||
        a.id - b.id
      );
    });
    // other-hotel entries of the listed employees
    const other = emps.length
      ? ((await db
          .selectFrom('schedule')
          .selectAll()
          .where(
            'employee_id',
            'in',
            emps.map((e) => e.id),
          )
          .where('hotel_id', 'not in', hotelIds)
          .where('shift_date', '>=', from)
          .where('shift_date', '<=', to)
          .where('status', '<>', 'cancelled')
          .execute()) as EntryRow[])
      : [];
    for (const e of sorted) {
      const g = primaryGroup(e);
      const contract = env.contractAt(e, from) ?? env.contractAt(e, to);
      const reduced = !visibleEmp(e);
      const weekly = contract
        ? (contract.weeklyTarget ??
          (contract.monthlyTarget != null ? (contract.monthlyTarget * 12) / 52 : null))
        : null;
      const monthly = contract
        ? (contract.monthlyTarget ??
          (contract.weeklyTarget != null ? (contract.weeklyTarget * 52) / 12 : null))
        : null;
      const target = prm.range === 'week' ? weekly : monthly;
      let credit: number | null = null;
      if (!reduced && contract && contract.workingModel === 'salary') {
        const holidays = new Set((await resolveHolidayRows(db, e.primaryHotelId, from, to)).keys());
        const days = new Set<string>();
        for (const a of absRows.filter(
          (x) => x.employee_id === e.id && x.status === 'approved' && x.credits_hours,
        )) {
          countedDays(
            a.start_date < from ? from : a.start_date,
            a.end_date > to ? to : a.end_date,
            contract.workingWeekdays,
            holidays,
          ).forEach((d) => days.add(d));
        }
        credit = round1(
          (contract.dailyTarget ??
            (weekly != null ? weekly / Math.max(1, contract.workingWeekdays.length) : 0)) * days.size,
        );
      }
      const mine = (env.entries.get(e.id) ?? []).filter((r) => r.shift_date >= from && r.shift_date <= to);
      const total =
        mine.reduce(
          (a, r) =>
            a +
            workingMinutes({
              startMs: r.planned_start.getTime(),
              endMs: r.planned_end.getTime(),
              breakMinutes: r.planned_break_minutes,
            }),
          0,
        ) / 60;
      rows.push({
        key: `emp:${e.id}`,
        kind: 'employee',
        employeeId: e.id,
        label: e.displayName,
        personnelNumber: reduced ? null : e.personnelNumber,
        isMinor: isMinor(
          e.dateOfBirth,
          from > env.today(e.primaryHotelId) ? from : env.today(e.primaryHotelId),
        ),
        isFloater: e.isFloater,
        homeHotel: { id: e.primaryHotelId, name: env.hotels.get(e.primaryHotelId)?.name ?? '' },
        isOtherHotel: !hotelIds.includes(e.primaryHotelId),
        hotelId: g?.hotel_id ?? null,
        hotelName: hotels.find((h) => h.id === g?.hotel_id)?.name ?? '',
        departmentId: g?.id ?? null,
        departmentName: g?.name ?? '',
        reduced,
        targetHours: reduced || target == null ? null : round1(target),
        creditHours: credit,
        totalHours: round1(total),
        cells: dates.map((date) => ({
          date,
          locked: cellLock(date, g?.hotel_id),
          entries: [
            ...liveEntries
              .filter((r) => r.employee_id === e.id && r.shift_date === date)
              .map((r) => entryOut(r)),
            ...ghosts.filter((r) => r.employee_id === e.id && r.shift_date === date).map((r) => entryOut(r)),
            ...other
              .filter((r) => r.employee_id === e.id && r.shift_date === date)
              .map((r) => ({
                ...entryOut(r),
                isOtherHotel: true,
                otherHotelName: env.hotels.get(r.hotel_id)?.name ?? '',
                readOnly: true,
                warnings: [],
              })),
          ],
          absenceIds: absences
            .filter((a) => a.employeeId === e.id && a.from <= date && a.to >= date)
            .map((a) => a.id),
        })),
      });
    }
  } else {
    const adhoc = (hotelId: number) => liveEntries.filter((r) => r.hotel_id === hotelId && !r.shift_id);
    for (const h of hotels) {
      for (const d of depts.filter((x) => x.hotel_id === h.id)) {
        for (const s of shifts.filter((x) => x.department_id === d.id)) {
          const st = staffing.get(s.id);
          let total = 0;
          let open = 0;
          const cells = dates.map((date) => {
            const entries = liveEntries.filter((r) => r.shift_id === s.id && r.shift_date === date);
            const ghostsHere = ghosts.filter((r) => r.shift_id === s.id && r.shift_date === date);
            const required = requiredOn(st, date);
            const assigned = entries.length;
            const o = openSlotsFn(required, assigned);
            open += o;
            total += entries.reduce(
              (a, r) =>
                a +
                hoursOf({
                  startMs: r.planned_start.getTime(),
                  endMs: r.planned_end.getTime(),
                  breakMinutes: r.planned_break_minutes,
                }),
              0,
            );
            return {
              date,
              required,
              assigned,
              open: o,
              locked: cellLock(date, h.id),
              entries: [...entries.map((r) => entryOut(r)), ...ghostsHere.map((r) => entryOut(r))],
            };
          });
          rows.push({
            key: `shift:${s.id}`,
            kind: 'shift',
            shiftId: s.id,
            label: `${s.name} ${String(s.start_time).slice(0, 5)}–${String(s.end_time).slice(0, 5)}`,
            name: s.name,
            startTime: String(s.start_time).slice(0, 5),
            endTime: String(s.end_time).slice(0, 5),
            hotelId: h.id,
            hotelName: h.name,
            departmentId: d.id,
            departmentName: d.name,
            totalHours: round1(total),
            openSlots: open,
            cells,
          });
        }
      }
      const extra = adhoc(h.id);
      if (extra.length) {
        rows.push({
          key: `adhoc:${h.id}`,
          kind: 'adhoc',
          shiftId: null,
          label: 'Ohne Schicht',
          hotelId: h.id,
          hotelName: h.name,
          departmentId: null,
          departmentName: '',
          totalHours: round1(
            extra.reduce(
              (a, r) =>
                a +
                hoursOf({
                  startMs: r.planned_start.getTime(),
                  endMs: r.planned_end.getTime(),
                  breakMinutes: r.planned_break_minutes,
                }),
              0,
            ),
          ),
          openSlots: 0,
          cells: dates.map((date) => ({
            date,
            required: 0,
            assigned: extra.filter((r) => r.shift_date === date).length,
            open: 0,
            locked: cellLock(date, h.id),
            entries: extra.filter((r) => r.shift_date === date).map((r) => entryOut(r)),
          })),
        });
      }
    }
  }

  // ---- totals, counts, status
  const perDay = dates.map((date) => {
    const on = liveEntries.filter((r) => r.shift_date === date);
    return {
      date,
      hours: round1(
        on.reduce(
          (a, r) =>
            a +
            hoursOf({
              startMs: r.planned_start.getTime(),
              endMs: r.planned_end.getTime(),
              breakMinutes: r.planned_break_minutes,
            }),
          0,
        ),
      ),
      headcount: new Set(on.map((r) => r.employee_id)).size,
    };
  });
  const openRequests = await openRequestCount(db, hotelIds);
  const snaps = await Promise.all(
    hotelIds.flatMap((h) => weeksOf(from, to).map((w) => latestSnapshot(db, h, w))),
  );
  const drafts = liveEntries.filter((r) => r.status === 'draft').length;
  const status = drafts === 0 && changes.length === 0 && snaps.every(Boolean) ? 'published' : 'draft';
  return {
    hotelIds,
    view: prm.view,
    range: prm.range,
    from,
    to,
    status,
    days,
    rows,
    absences,
    totals: { perDay },
    changes,
    counts: {
      drafts,
      warnings: [...warningsOf.keys()].length,
      underStaffed: coverage.filter((c) => c.underStaffed).length,
      openRequests,
    },
    coverage,
  };
}

const weeksOf = (from: string, to: string) => {
  const out: string[] = [];
  for (let m = mondayOf(from); m <= to; m = addDays(m, 7)) out.push(m);
  return out;
};

export async function openRequestCount(db: Db, hotelIds: number[]): Promise<number> {
  if (!hotelIds.length) return 0;
  const n = async (q: any) => Number((await q.executeTakeFirstOrThrow()).n);
  const t = await n(
    db
      .selectFrom('time_off as t')
      .innerJoin('employee as e', 'e.employee_id', 't.employee_id')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('e.primary_hotel_id', 'in', hotelIds)
      .where('t.status', '=', 'pending'),
  );
  const c = await n(
    db
      .selectFrom('time_correction_request')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('hotel_id', 'in', hotelIds)
      .where('status', '=', 'pending'),
  );
  const w = await n(
    db
      .selectFrom('punch_record')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('hotel_id', 'in', hotelIds)
      .where('approval_status', '=', 'pending')
      .where('actual_punch_out', 'is not', null),
  );
  return t + c + w;
}
