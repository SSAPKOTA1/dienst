import {
  addDays,
  categoryMinutes,
  countedDays,
  DEFAULT_CATEGORIES,
  isNightWork,
  isoWeekday,
  restCompensations,
  mergeLimits,
  type DaySegment,
  type HourCategory,
  type RuleLimits,
} from '@dienst/rules';
import type { Db, DbOrTrx } from '../db';
import { localDate, localMinutes, zonedInstant } from '../lib/time';
import { resolveHolidays } from './holidays';
import { buildLedger } from './timeAccount';
import { loadStaffing, requiredOn } from './staffing';
import { eachDay } from '@dienst/rules';

// ---------------------------------------------------------------------------------------------
// hour categories

/** Code defaults overridden by the company's own rows of the same code; inactive ones are dropped. */
export async function loadCategories(db: DbOrTrx, companyId: number) {
  const own = await db
    .selectFrom('hour_category')
    .selectAll()
    .where('company_id', '=', companyId)
    .orderBy('id')
    .execute();
  const byCode = new Map<
    string,
    {
      id: number | null;
      code: string;
      name: string;
      rule: unknown;
      active: boolean;
      company_id: number | null;
    }
  >();
  for (const d of DEFAULT_CATEGORIES)
    byCode.set(d.code, {
      id: null,
      code: d.code,
      name: d.name,
      rule: d.rule,
      active: true,
      company_id: null,
    });
  for (const r of own) byCode.set(r.code, r);
  return [...byCode.values()].filter((r) => r.active);
}

/** Splits an instant range at hotel-local midnights (DST safe). */
export function splitSegments(start: Date, end: Date, tz: string): DaySegment[] {
  const segs: DaySegment[] = [];
  let cur = start.getTime();
  const stopAt = end.getTime();
  while (cur < stopAt) {
    const date = localDate(new Date(cur), tz);
    const nextMidnight = zonedInstant(addDays(date, 1), '00:00', tz).getTime();
    const stop = Math.min(stopAt, nextMidnight);
    const fromMin = localMinutes(new Date(cur), tz);
    segs.push({ date, fromMin, toMin: fromMin + Math.round((stop - cur) / 60000) });
    cur = stop;
  }
  return segs;
}

/** Category minutes of one paid window; recorded break segments are deducted. */
export function windowCategoryMinutes(
  paidStart: Date,
  paidEnd: Date,
  breakSegments: Array<{ start: string; end: string }> | null,
  tz: string,
  cats: HourCategory[],
  holidays: ReadonlySet<string>,
): Record<string, number> {
  const out = categoryMinutes(splitSegments(paidStart, paidEnd, tz), cats, holidays);
  for (const b of breakSegments ?? []) {
    const bs = new Date(b.start);
    const be = new Date(b.end);
    if (!(be > bs)) continue;
    const m = categoryMinutes(splitSegments(bs, be, tz), cats, holidays);
    for (const [k, v] of Object.entries(m)) out[k] = Math.max(0, (out[k] ?? 0) - v);
  }
  return out;
}

const toCats = (rows: Array<{ code: string; rule: unknown }>): HourCategory[] =>
  rows.map((r) => ({ code: r.code, rule: r.rule as HourCategory['rule'] }));

/** Approved record minutes per category and employee within [from, to] (shift dates). */
export async function categoryTotals(
  db: DbOrTrx,
  companyId: number,
  employeeIds: number[],
  from: string,
  to: string,
): Promise<{
  totals: Map<number, Record<string, number>>;
  categories: Array<{ code: string; name: string }>;
}> {
  const catRows = await loadCategories(db, companyId);
  const cats = toCats(catRows);
  const totals = new Map<number, Record<string, number>>();
  if (!employeeIds.length)
    return { totals, categories: catRows.map((c) => ({ code: c.code, name: c.name })) };
  const recs = await db
    .selectFrom('punch_record as p')
    .innerJoin('hotel as h', 'h.id', 'p.hotel_id')
    .select(['p.employee_id', 'p.hotel_id', 'p.paid_start', 'p.paid_end', 'p.break_segments', 'h.timezone'])
    .where('p.employee_id', 'in', employeeIds)
    .where('p.approval_status', '=', 'approved')
    .where('p.paid_start', 'is not', null)
    .where('p.paid_end', 'is not', null)
    .where('p.shift_date', '>=', from)
    .where('p.shift_date', '<=', to)
    .execute();
  const holidays = new Map<number, Set<string>>();
  for (const r of recs) {
    if (!holidays.has(r.hotel_id))
      holidays.set(
        r.hotel_id,
        new Set((await resolveHolidays(db, r.hotel_id, addDays(from, -1), addDays(to, 1))).keys()),
      );
    const m = windowCategoryMinutes(
      r.paid_start!,
      r.paid_end!,
      (r.break_segments as Array<{ start: string; end: string }> | null) ?? null,
      r.timezone,
      cats,
      holidays.get(r.hotel_id)!,
    );
    const t = totals.get(r.employee_id) ?? {};
    for (const [k, v] of Object.entries(m)) t[k] = (t[k] ?? 0) + v;
    totals.set(r.employee_id, t);
  }
  return { totals, categories: catRows.map((c) => ({ code: c.code, name: c.name })) };
}

// ---------------------------------------------------------------------------------------------
// payroll export (hours and categories only, never wages)

const ABSENCE_CODES = [
  'annual_leave',
  'sick_leave',
  'unpaid_leave',
  'comp_time',
  'special_leave',
  'training',
  'child_sick',
  'parental_leave',
  'maternity_leave',
  'vocational_school',
  'rest_day',
];

export interface PayrollRow {
  employeeId: number;
  personnelNumber: string;
  name: string;
  hotel: string;
  workedHours: number;
  categoryHours: Record<string, number>;
  absenceDays: Record<string, number>;
  timeAccountHours: number | null;
}

export async function buildPayroll(db: Db, hotelIds: number[], month: string, nowDate: string) {
  const from = `${month}-01`;
  const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);
  const emps = hotelIds.length
    ? await db
        .selectFrom('employee as e')
        .innerJoin('hotel as h', 'h.id', 'e.primary_hotel_id')
        .select([
          'e.employee_id',
          'e.company_id',
          'e.personnel_number',
          'e.first_name',
          'e.last_name',
          'h.name as hotel',
        ])
        .where('e.primary_hotel_id', 'in', hotelIds)
        .where('e.contract_start_date', '<=', to)
        .orderBy('e.personnel_number')
        .execute()
    : [];
  const byCompany = new Map<number, number[]>();
  for (const e of emps) byCompany.set(e.company_id, [...(byCompany.get(e.company_id) ?? []), e.employee_id]);
  const cat = new Map<number, Record<string, number>>();
  const names = new Map<string, string>();
  for (const [companyId, ids] of byCompany) {
    const r = await categoryTotals(db, companyId, ids, from, to);
    for (const [k, v] of r.totals) cat.set(k, v);
    for (const c of r.categories) names.set(c.code, c.name);
  }
  const worked = emps.length
    ? await db
        .selectFrom('punch_record')
        .select(['employee_id', (eb) => eb.fn.sum<number>('paid_hours').as('h')])
        .where(
          'employee_id',
          'in',
          emps.map((e) => e.employee_id),
        )
        .where('approval_status', '=', 'approved')
        .where('shift_date', '>=', from)
        .where('shift_date', '<=', to)
        .groupBy('employee_id')
        .execute()
    : [];
  const rows: PayrollRow[] = [];
  const nextMonth = addDays(to, 1);
  for (const e of emps) {
    const c = await db
      .selectFrom('employee_contract')
      .select('working_weekdays')
      .where('employee_id', '=', e.employee_id)
      .where('valid_from', '<=', to)
      .orderBy('valid_from', 'desc')
      .limit(1)
      .executeTakeFirst();
    const hol = new Set(
      (
        await resolveHolidays(
          db,
          (
            await db
              .selectFrom('employee')
              .select('primary_hotel_id')
              .where('employee_id', '=', e.employee_id)
              .executeTakeFirstOrThrow()
          ).primary_hotel_id,
          from,
          to,
        )
      ).keys(),
    );
    const offs = await db
      .selectFrom('time_off')
      .select(['start_date', 'end_date', 'type', 'half_day'])
      .where('employee_id', '=', e.employee_id)
      .where('status', '=', 'approved')
      .where('end_date', '>=', from)
      .where('start_date', '<=', to)
      .execute();
    const absenceDays: Record<string, number> = {};
    for (const o of offs) {
      const n = countedDays(
        o.start_date < from ? from : o.start_date,
        o.end_date > to ? to : o.end_date,
        c?.working_weekdays ?? [1, 2, 3, 4, 5],
        hol,
      ).length;
      absenceDays[o.type] = (absenceDays[o.type] ?? 0) + (o.half_day ? 0.5 : n);
    }
    const mins = cat.get(e.employee_id) ?? {};
    const ledger = await buildLedger(db, e.employee_id, nowDate < nextMonth ? nowDate : nextMonth);
    rows.push({
      employeeId: e.employee_id,
      personnelNumber: e.personnel_number,
      name: `${e.last_name}, ${e.first_name}`,
      hotel: e.hotel,
      workedHours:
        Math.round(Number(worked.find((w) => w.employee_id === e.employee_id)?.h ?? 0) * 100) / 100,
      categoryHours: Object.fromEntries(
        Object.entries(mins).map(([k, v]) => [k, Math.round((v / 60) * 100) / 100]),
      ),
      absenceDays,
      timeAccountHours: ledger?.balanceHours ?? null,
    });
  }
  return {
    month,
    from,
    to,
    categories: [...names].map(([code, name]) => ({ code, name })),
    absenceCodes: ABSENCE_CODES,
    rows,
  };
}

// ---------------------------------------------------------------------------------------------
// compliance reports

export async function loadLimits(db: DbOrTrx, hotelId: number): Promise<RuleLimits> {
  const r = await db
    .selectFrom('hotel as h')
    .innerJoin('company as c', 'c.id', 'h.company_id')
    .leftJoin('rule_profile as hp', 'hp.id', 'h.rule_profile_id')
    .leftJoin('rule_profile as cp', 'cp.id', 'c.rule_profile_id')
    .select(['hp.rules as hr', 'cp.rules as cr'])
    .where('h.id', '=', hotelId)
    .executeTakeFirst();
  return mergeLimits((r?.hr ?? r?.cr) as Partial<RuleLimits> | null);
}

export async function restCompensationReport(
  db: Db,
  hotelIds: number[],
  from: string,
  to: string,
  now: Date,
) {
  if (!hotelIds.length) return [];
  const rows = await db
    .selectFrom('schedule as s')
    .innerJoin('employee as e', 'e.employee_id', 's.employee_id')
    .select(['s.employee_id', 's.hotel_id', 's.planned_start', 's.planned_end', 'e.display_name'])
    .where('e.primary_hotel_id', 'in', hotelIds)
    .where('s.status', '<>', 'cancelled')
    .where('s.shift_date', '>=', addDays(from, -3))
    .where('s.shift_date', '<=', addDays(to, 31))
    .orderBy('s.planned_start')
    .execute();
  const byEmp = new Map<number, typeof rows>();
  for (const r of rows) byEmp.set(r.employee_id, [...(byEmp.get(r.employee_id) ?? []), r]);
  const out: Array<{
    employeeId: number;
    displayName: string;
    shortenedFrom: string;
    shortenedTo: string;
    gapMinutes: number;
    dueBy: string;
    compensatedOn: string | null;
    status: 'ok' | 'open' | 'overdue';
  }> = [];
  for (const [empId, list] of byEmp) {
    const limits = await loadLimits(db, list[0]!.hotel_id);
    const comps = restCompensations(
      list.map((r) => ({ startMs: r.planned_start.getTime(), endMs: r.planned_end.getTime() })),
      now.getTime(),
      limits,
    );
    for (const c of comps) {
      const d = localDate(new Date(c.shortenedToMs), 'Europe/Berlin');
      if (d < from || d > to) continue;
      out.push({
        employeeId: empId,
        displayName: list[0]!.display_name ?? '',
        shortenedFrom: new Date(c.shortenedFromMs).toISOString(),
        shortenedTo: new Date(c.shortenedToMs).toISOString(),
        gapMinutes: c.gapMinutes,
        dueBy: new Date(c.dueMs).toISOString(),
        compensatedOn: c.compensatedByMs ? new Date(c.compensatedByMs).toISOString() : null,
        status: c.status,
      });
    }
  }
  return out.sort((a, b) => a.shortenedTo.localeCompare(b.shortenedTo));
}

/** Sunday / holiday work and the replacement rest day (`rest_day` absence): within 2 weeks for Sundays, 8 weeks for holidays. */
export async function replacementRestReport(
  db: Db,
  hotelIds: number[],
  from: string,
  to: string,
  today: string,
) {
  if (!hotelIds.length) return [];
  const rows = await db
    .selectFrom('schedule as s')
    .innerJoin('employee as e', 'e.employee_id', 's.employee_id')
    .select(['s.employee_id', 's.hotel_id', 's.shift_date', 'e.display_name'])
    .where('e.primary_hotel_id', 'in', hotelIds)
    .where('s.status', '<>', 'cancelled')
    .where('s.shift_date', '>=', from)
    .where('s.shift_date', '<=', to)
    .execute();
  const hol = new Map<number, Set<string>>();
  const out: Array<{
    employeeId: number;
    displayName: string;
    date: string;
    kind: 'sunday' | 'holiday';
    dueBy: string;
    restDayOn: string | null;
    status: 'ok' | 'open' | 'overdue';
  }> = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!hol.has(r.hotel_id))
      hol.set(r.hotel_id, new Set((await resolveHolidays(db, r.hotel_id, from, to)).keys()));
    const holiday = hol.get(r.hotel_id)!.has(r.shift_date);
    const sunday = isoWeekday(r.shift_date) === 7;
    if (!holiday && !sunday) continue;
    const key = `${r.employee_id}:${r.shift_date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = holiday ? 'holiday' : 'sunday';
    const dueBy = addDays(r.shift_date, holiday ? 56 : 14);
    const rest = await db
      .selectFrom('time_off')
      .select('start_date')
      .where('employee_id', '=', r.employee_id)
      .where('type', '=', 'rest_day')
      .where('status', '=', 'approved')
      .where('start_date', '>', r.shift_date)
      .where('start_date', '<=', dueBy)
      .orderBy('start_date')
      .limit(1)
      .executeTakeFirst();
    out.push({
      employeeId: r.employee_id,
      displayName: r.display_name ?? '',
      date: r.shift_date,
      kind,
      dueBy,
      restDayOn: rest?.start_date ?? null,
      status: rest ? 'ok' : today > dueBy ? 'overdue' : 'open',
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Free Sundays and night-worker status per employee for a year (planned entries). */
export async function sundayNightReport(db: Db, hotelIds: number[], year: number, today: string) {
  if (!hotelIds.length) return [];
  const emps = await db
    .selectFrom('employee')
    .select(['employee_id', 'display_name', 'primary_hotel_id', 'date_of_birth'])
    .where('primary_hotel_id', 'in', hotelIds)
    .where('status', '=', 'active')
    .orderBy('last_name')
    .execute();
  const nightFrom = addDays(today, -365);
  const rows = await db
    .selectFrom('schedule')
    .select(['employee_id', 'hotel_id', 'shift_date', 'planned_start', 'planned_end'])
    .where('employee_id', 'in', emps.map((e) => e.employee_id).length ? emps.map((e) => e.employee_id) : [-1])
    .where('status', '<>', 'cancelled')
    .where('shift_date', '>=', nightFrom < `${year}-01-01` ? nightFrom : `${year}-01-01`)
    .where('shift_date', '<=', `${year}-12-31`)
    .execute();
  const tz = new Map<number, string>(
    (await db.selectFrom('hotel').select(['id', 'timezone']).execute()).map((h) => [h.id, h.timezone]),
  );
  let sundays = 0;
  for (let d = `${year}-01-01`; d <= `${year}-12-31`; d = addDays(d, 1)) if (isoWeekday(d) === 7) sundays++;
  return emps.map((e) => {
    const mine = rows.filter((r) => r.employee_id === e.employee_id);
    const sundayDates = new Set(
      mine
        .filter((r) => r.shift_date.startsWith(String(year)) && isoWeekday(r.shift_date) === 7)
        .map((r) => r.shift_date),
    );
    const nights = new Set(
      mine
        .filter((r) => r.shift_date >= nightFrom && r.shift_date <= today)
        .filter((r) => {
          const z = tz.get(r.hotel_id) ?? 'Europe/Berlin';
          const start = localMinutes(r.planned_start, z);
          return isNightWork(
            start,
            start + Math.round((r.planned_end.getTime() - r.planned_start.getTime()) / 60000),
          );
        })
        .map((r) => r.shift_date),
    );
    return {
      employeeId: e.employee_id,
      displayName: e.display_name ?? '',
      sundaysWorked: sundayDates.size,
      sundaysFree: sundays - sundayDates.size,
      sundaysTotal: sundays,
      nightsLast12Months: nights.size,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// analytics (aggregated; no per-employee ranking or scoring; absence figures need at least 5 employees)

export async function buildAnalytics(db: Db, hotelIds: number[], from: string, to: string, today: string) {
  const empty = {
    from,
    to,
    departments: [],
    approvals: { pending: 0, buckets: { '0-2': 0, '3-5': 0, '6+': 0 } },
    overrides: 0,
    corrections: { requests: 0, records: 0, rate: null as number | null },
    openSlots: 0,
  };
  if (!hotelIds.length) return empty;
  const depts = await db
    .selectFrom('department as d')
    .innerJoin('hotel as h', 'h.id', 'd.hotel_id')
    .select(['d.id', 'd.name', 'd.hotel_id', 'h.name as hotel'])
    .where('d.hotel_id', 'in', hotelIds)
    .orderBy('d.hotel_id')
    .orderBy('d.id')
    .execute();
  const departments = [];
  for (const d of depts) {
    const emps = await db
      .selectFrom('employee')
      .select('employee_id')
      .where('primary_department_id', '=', d.id)
      .where('status', '=', 'active')
      .execute();
    const ids = emps.map((e) => e.employee_id);
    const planned = ids.length
      ? await db
          .selectFrom('schedule')
          .select(['planned_start', 'planned_end', 'planned_break_minutes'])
          .where('employee_id', 'in', ids)
          .where('status', '<>', 'cancelled')
          .where('shift_date', '>=', from)
          .where('shift_date', '<=', to)
          .execute()
      : [];
    const plannedHours = planned.reduce(
      (a, r) =>
        a + ((r.planned_end.getTime() - r.planned_start.getTime()) / 60000 - r.planned_break_minutes) / 60,
      0,
    );
    const actual = ids.length
      ? await db
          .selectFrom('punch_record')
          .select((eb) => eb.fn.sum<number>('paid_hours').as('h'))
          .where('employee_id', 'in', ids)
          .where('approval_status', '=', 'approved')
          .where('shift_date', '>=', from)
          .where('shift_date', '<=', to)
          .executeTakeFirst()
      : undefined;
    let accountTotal: number | null = null;
    for (const id of ids) {
      const l = await buildLedger(db, id, today);
      if (l) accountTotal = (accountTotal ?? 0) + l.balanceHours;
    }
    const absentDays = ids.length
      ? await db
          .selectFrom('time_off')
          .select(['start_date', 'end_date'])
          .where('employee_id', 'in', ids)
          .where('status', '=', 'approved')
          .where('type', '<>', 'off_day')
          .where('end_date', '>=', from)
          .where('start_date', '<=', to)
          .execute()
      : [];
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    const absent = absentDays.reduce(
      (a, o) =>
        a +
        (Math.round(
          (Date.parse(o.end_date < to ? o.end_date : to) -
            Date.parse(o.start_date > from ? o.start_date : from)) /
            86400000,
        ) +
          1),
      0,
    );
    departments.push({
      departmentId: d.id,
      name: d.name,
      hotelId: d.hotel_id,
      hotel: d.hotel,
      employees: ids.length,
      plannedHours: Math.round(plannedHours * 10) / 10,
      actualHours: Math.round(Number(actual?.h ?? 0) * 10) / 10,
      timeAccountHours: accountTotal == null ? null : Math.round(accountTotal * 10) / 10,
      // privacy: no absence figure for departments with fewer than 5 employees
      absenceRate: ids.length >= 5 ? Math.round((absent / (ids.length * days)) * 1000) / 10 : null,
    });
  }
  const pending = await db
    .selectFrom('punch_record')
    .select('shift_date')
    .where('hotel_id', 'in', hotelIds)
    .where('approval_status', '=', 'pending')
    .where('actual_punch_out', 'is not', null)
    .execute();
  const buckets = { '0-2': 0, '3-5': 0, '6+': 0 };
  for (const p of pending) {
    const age = Math.max(0, Math.round((Date.parse(today) - Date.parse(p.shift_date)) / 86400000));
    buckets[age <= 2 ? '0-2' : age <= 5 ? '3-5' : '6+']++;
  }
  const overrides = await db
    .selectFrom('audit_log')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('action', '=', 'rule_override')
    .where('hotel_id', 'in', hotelIds)
    .where('created_at', '>=', new Date(`${from}T00:00:00Z`))
    .where('created_at', '<', new Date(Date.parse(`${to}T00:00:00Z`) + 86400000))
    .executeTakeFirstOrThrow();
  const corr = await db
    .selectFrom('time_correction_request')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('hotel_id', 'in', hotelIds)
    .where('created_at', '>=', new Date(`${from}T00:00:00Z`))
    .where('created_at', '<', new Date(Date.parse(`${to}T00:00:00Z`) + 86400000))
    .executeTakeFirstOrThrow();
  const recs = await db
    .selectFrom('punch_record')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('hotel_id', 'in', hotelIds)
    .where('shift_date', '>=', from)
    .where('shift_date', '<=', to)
    .executeTakeFirstOrThrow();
  // open slots: required headcount minus assigned entries per shift and day (capped to 62 days)
  const shifts = await db.selectFrom('shift').select('id').where('hotel_id', 'in', hotelIds).execute();
  let openSlots = 0;
  if (shifts.length) {
    const staffing = await loadStaffing(
      db,
      shifts.map((x) => x.id),
    );
    const days = eachDay(from, to).slice(0, 62);
    const assigned = await db
      .selectFrom('schedule')
      .select(['shift_id', 'shift_date'])
      .where(
        'shift_id',
        'in',
        shifts.map((x) => x.id),
      )
      .where('status', '<>', 'cancelled')
      .where('shift_date', '>=', days[0]!)
      .where('shift_date', '<=', days[days.length - 1]!)
      .execute();
    for (const sh of shifts)
      for (const d of days)
        openSlots += Math.max(
          0,
          requiredOn(staffing.get(sh.id), d) -
            assigned.filter((a) => a.shift_id === sh.id && a.shift_date === d).length,
        );
  }
  return {
    from,
    to,
    departments,
    approvals: { pending: pending.length, buckets },
    overrides: Number(overrides.n),
    corrections: {
      requests: Number(corr.n),
      records: Number(recs.n),
      rate: Number(recs.n) ? Math.round((Number(corr.n) / Number(recs.n)) * 1000) / 10 : null,
    },
    openSlots,
  };
}
