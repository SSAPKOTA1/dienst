import {
  addDays,
  aggregate,
  checkEntry,
  displayName,
  mondayOf,
  workingMinutes,
  type AvailabilityRule,
  type LeaveWishRule,
  type RuleLimits,
  isNightWork,
  isoWeekday,
  type RuleOther,
  type ShiftWishRule,
  type Violation,
} from '@dienst/rules';
import type { DbOrTrx } from '../../db';
import { localDate, localMinutes } from '../../lib/time';

export interface PlanEmployee {
  id: number;
  userId: number;
  companyId: number;
  primaryHotelId: number;
  primaryDepartmentId: number;
  firstName: string;
  lastName: string;
  displayName: string;
  personnelNumber: string;
  dateOfBirth: string;
  active: boolean;
  isFloater: boolean;
  hotelIds: number[];
  departmentIds: number[];
  contracts: Array<{
    validFrom: string;
    validTo: string | null;
    monthlyHoursCap: number | null;
    workingWeekdays: number[];
    workingModel: string;
    weeklyTarget: number | null;
    monthlyTarget: number | null;
    dailyTarget: number | null;
    vacationDaysPerYear: number;
  }>;
}

export interface EntryRow {
  id: number;
  hotel_id: number;
  employee_id: number;
  shift_id: number | null;
  shift_date: string;
  planned_start: Date;
  planned_end: Date;
  planned_break_minutes: number;
  status: string;
  published_at: Date | null;
  version: number;
  cancel_reason: string | null;
  time_off_id: number | null;
}

export interface HotelInfo {
  id: number;
  companyId: number;
  name: string;
  tz: string;
  state: string | null;
}

export interface Subject {
  employeeId: number;
  hotelId: number;
  shiftId: number | null;
  departmentId: number | null;
  startMs: number;
  endMs: number;
  breakMinutes: number;
  /** entries that this subject replaces (not counted as "others") */
  ignoreIds?: number[];
  entryId?: number | null;
}

const dayPad = 3;
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const monthEnd = (d: string) => {
  const [y, m] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** Everything the rule checks need for a set of employees, loaded in a few queries. */
export class PlanEnv {
  employees = new Map<number, PlanEmployee>();
  entries = new Map<number, EntryRow[]>(); // per employee, non-cancelled
  absenceRanges = new Map<number, Array<{ from: string; to: string }>>();
  closed: Array<{ companyId: number; hotelId: number | null; from: string; to: string }> = [];
  hotels = new Map<number, HotelInfo>();
  shiftWishes = new Map<number, ShiftWishRule[]>();
  leaveWishes = new Map<number, LeaveWishRule[]>();
  /** limits of the rule profile per hotel (hotel profile, else company profile, else statutory defaults) */
  limits = new Map<number, Partial<RuleLimits>>();
  availability = new Map<number, AvailabilityRule[]>();
  qualifications = new Map<number, Array<{ id: number; validUntil: string | null }>>();
  /** qualification required per shift id (only shifts that require one) */
  shiftQualification = new Map<number, number>();
  /** compact year history per employee for the Sunday and night statistics */
  calendar = new Map<number, Array<{ id: number; date: string; sunday: boolean; night: boolean }>>();

  constructor(readonly now: Date) {}

  static async create(
    db: DbOrTrx,
    now: Date,
    opts: { employeeIds: number[]; from: string; to: string },
  ): Promise<PlanEnv> {
    const env = new PlanEnv(now);
    const ids = [...new Set(opts.employeeIds)];
    const from = addDays(monthStart(opts.from), -dayPad);
    const to = addDays(monthEnd(opts.to), dayPad);
    const hotels = await db
      .selectFrom('hotel')
      .select(['id', 'company_id', 'name', 'timezone', 'federal_state'])
      .execute();
    for (const h of hotels)
      env.hotels.set(h.id, {
        id: h.id,
        companyId: h.company_id,
        name: h.name,
        tz: h.timezone,
        state: h.federal_state,
      });
    if (ids.length) {
      const emps = await db.selectFrom('employee').selectAll().where('employee_id', 'in', ids).execute();
      const hs = await db
        .selectFrom('employee_hotel')
        .select(['employee_id', 'hotel_id'])
        .where('employee_id', 'in', ids)
        .execute();
      const ds = await db
        .selectFrom('employee_department')
        .select(['employee_id', 'department_id'])
        .where('employee_id', 'in', ids)
        .execute();
      const cs = await db
        .selectFrom('employee_contract')
        .selectAll()
        .where('employee_id', 'in', ids)
        .execute();
      for (const e of emps) {
        env.employees.set(e.employee_id, {
          id: e.employee_id,
          userId: e.user_id,
          companyId: e.company_id,
          primaryHotelId: e.primary_hotel_id,
          primaryDepartmentId: e.primary_department_id,
          firstName: e.first_name,
          lastName: e.last_name,
          displayName: e.display_name ?? displayName(e.first_name, e.last_name),
          personnelNumber: e.personnel_number,
          dateOfBirth: e.date_of_birth,
          active: e.status === 'active',
          isFloater: e.is_floater,
          hotelIds: hs.filter((x) => x.employee_id === e.employee_id).map((x) => x.hotel_id),
          departmentIds: ds.filter((x) => x.employee_id === e.employee_id).map((x) => x.department_id),
          contracts: cs
            .filter((c) => c.employee_id === e.employee_id)
            .map((c) => ({
              validFrom: c.valid_from,
              validTo: c.valid_to,
              monthlyHoursCap: c.monthly_hours_cap,
              workingWeekdays: c.working_weekdays,
              workingModel: c.working_model,
              weeklyTarget: c.target_hours_per_week,
              monthlyTarget: c.target_hours_per_month,
              dailyTarget: c.daily_target_hours,
              vacationDaysPerYear: c.vacation_days_per_year,
            })),
        });
      }
      const entries = await db
        .selectFrom('schedule')
        .select([
          'id',
          'hotel_id',
          'employee_id',
          'shift_id',
          'shift_date',
          'planned_start',
          'planned_end',
          'planned_break_minutes',
          'status',
          'published_at',
          'version',
          'cancel_reason',
          'time_off_id',
        ])
        .where('employee_id', 'in', ids)
        .where('status', '<>', 'cancelled')
        .where('shift_date', '>=', from)
        .where('shift_date', '<=', to)
        .execute();
      for (const id of ids) env.entries.set(id, []);
      for (const e of entries) env.entries.get(e.employee_id)!.push(e as EntryRow);
      const abs = await db
        .selectFrom('time_off')
        .select(['employee_id', 'start_date', 'end_date'])
        .where('employee_id', 'in', ids)
        .where('status', '=', 'approved')
        .where('half_day', 'is', null) // a half day does not block the other half
        .where('end_date', '>=', from)
        .where('start_date', '<=', to)
        .execute();
      for (const a of abs) {
        const l = env.absenceRanges.get(a.employee_id) ?? [];
        l.push({ from: a.start_date, to: a.end_date });
        env.absenceRanges.set(a.employee_id, l);
      }
    }
    if (ids.length) {
      const sw = await db
        .selectFrom('employee_shift_wish')
        .select(['employee_id', 'date', 'shift_id', 'priority'])
        .where('employee_id', 'in', ids)
        .where('status', 'in', ['pending', 'granted'])
        .where('date', '>=', from)
        .where('date', '<=', to)
        .execute();
      for (const w of sw)
        env.shiftWishes.set(w.employee_id, [
          ...(env.shiftWishes.get(w.employee_id) ?? []),
          { date: w.date, shiftId: w.shift_id, priority: w.priority },
        ]);
      const lw = await db
        .selectFrom('employee_leave_wish')
        .select(['employee_id', 'start_date', 'end_date', 'priority'])
        .where('employee_id', 'in', ids)
        .where('status', 'in', ['pending', 'granted'])
        .where('end_date', '>=', from)
        .where('start_date', '<=', to)
        .execute();
      for (const w of lw)
        env.leaveWishes.set(w.employee_id, [
          ...(env.leaveWishes.get(w.employee_id) ?? []),
          { from: w.start_date, to: w.end_date, priority: w.priority },
        ]);
    }
    if (ids.length) {
      const av = await db
        .selectFrom('employee_availability')
        .selectAll()
        .where('employee_id', 'in', ids)
        .where('valid_from', '<=', to)
        .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', from)]))
        .execute();
      const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      for (const a of av)
        env.availability.set(a.employee_id, [
          ...(env.availability.get(a.employee_id) ?? []),
          {
            weekday: a.weekday,
            fromMin: mins(String(a.from_time)),
            toMin: mins(String(a.to_time)),
            kind: a.kind as 'unavailable' | 'preferred',
            validFrom: a.valid_from,
            validTo: a.valid_to,
            note: a.note,
          },
        ]);
      const q = await db
        .selectFrom('employee_qualification')
        .selectAll()
        .where('employee_id', 'in', ids)
        .execute();
      for (const x of q)
        env.qualifications.set(x.employee_id, [
          ...(env.qualifications.get(x.employee_id) ?? []),
          { id: x.qualification_id, validUntil: x.valid_until },
        ]);
    }
    const sq = await db
      .selectFrom('shift')
      .select(['id', 'required_qualification_id'])
      .where('required_qualification_id', 'is not', null)
      .execute();
    for (const x of sq) env.shiftQualification.set(x.id, x.required_qualification_id!);
    const profiles = await db
      .selectFrom('hotel as h')
      .innerJoin('company as c', 'c.id', 'h.company_id')
      .leftJoin('rule_profile as hp', 'hp.id', 'h.rule_profile_id')
      .leftJoin('rule_profile as cp', 'cp.id', 'c.rule_profile_id')
      .select(['h.id', 'hp.rules as hotel_rules', 'cp.rules as company_rules'])
      .execute();
    for (const p of profiles) {
      const r = (p.hotel_rules ?? p.company_rules) as Partial<RuleLimits> | null;
      if (r) env.limits.set(p.id, r);
    }
    if (ids.length) {
      const yearFrom = addDays(opts.from, -366);
      const yearTo = addDays(opts.to, 366);
      const hist = await db
        .selectFrom('schedule')
        .select(['id', 'employee_id', 'hotel_id', 'shift_date', 'planned_start', 'planned_end'])
        .where('employee_id', 'in', ids)
        .where('status', '<>', 'cancelled')
        .where('shift_date', '>=', yearFrom)
        .where('shift_date', '<=', yearTo)
        .execute();
      for (const h of hist) {
        const l = env.slotLocal(h.hotel_id, h.planned_start.getTime(), h.planned_end.getTime());
        const list = env.calendar.get(h.employee_id) ?? [];
        list.push({
          id: h.id,
          date: h.shift_date,
          sunday: isoWeekday(h.shift_date) === 7,
          night: isNightWork(l.startLocalMin, l.endLocalMin),
        });
        env.calendar.set(h.employee_id, list);
      }
    }
    const periods = await db
      .selectFrom('payroll_period')
      .selectAll()
      .where('status', '=', 'closed')
      .where('period_end', '>=', from)
      .where('period_start', '<=', to)
      .execute();
    env.closed = periods.map((p) => ({
      companyId: p.company_id,
      hotelId: p.hotel_id,
      from: p.period_start,
      to: p.period_end,
    }));
    return env;
  }

  addEntry(row: EntryRow) {
    const l = this.entries.get(row.employee_id) ?? [];
    l.push(row);
    this.entries.set(row.employee_id, l);
  }

  hotel(id: number): HotelInfo {
    const h = this.hotels.get(id);
    if (!h) throw new Error(`hotel ${id} unknown`);
    return h;
  }
  today(hotelId: number): string {
    return localDate(this.now, this.hotel(hotelId).tz);
  }
  isClosed(hotelId: number, date: string): boolean {
    const h = this.hotel(hotelId);
    return this.closed.some(
      (p) =>
        p.companyId === h.companyId &&
        (p.hotelId == null || p.hotelId === hotelId) &&
        p.from <= date &&
        p.to >= date,
    );
  }
  contractAt(emp: PlanEmployee, date: string) {
    return emp.contracts.find((c) => c.validFrom <= date && (c.validTo == null || c.validTo >= date));
  }
  absentOn(empId: number, date: string): boolean {
    return (this.absenceRanges.get(empId) ?? []).some((r) => r.from <= date && r.to >= date);
  }

  /** local date and local clock minutes of a planned slot */
  slotLocal(hotelId: number, startMs: number, endMs: number) {
    const tz = this.hotel(hotelId).tz;
    const s = new Date(startMs);
    const e = new Date(endMs);
    const ld = localDate(s, tz);
    const endDate = localDate(e, tz);
    const dayOffset = Math.round(
      (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${ld}T00:00:00Z`)) / 86400000,
    );
    return {
      localDate: ld,
      startLocalMin: localMinutes(s, tz),
      endLocalMin: localMinutes(e, tz) + dayOffset * 1440,
    };
  }

  private other(row: EntryRow): RuleOther {
    return {
      id: row.id,
      startMs: row.planned_start.getTime(),
      endMs: row.planned_end.getTime(),
      breakMinutes: row.planned_break_minutes,
      localDate: row.shift_date,
    };
  }

  check(s: Subject, virtual: Subject[] = [], skip: string[] = []): Violation[] {
    const emp = this.employees.get(s.employeeId);
    if (!emp) throw new Error(`employee ${s.employeeId} not loaded`);
    const hotel = this.hotel(s.hotelId);
    const local = this.slotLocal(s.hotelId, s.startMs, s.endMs);
    const ignore = new Set(s.ignoreIds ?? []);
    const others: RuleOther[] = (this.entries.get(s.employeeId) ?? [])
      .filter((r) => !ignore.has(r.id))
      .map((r) => this.other(r));
    for (const v of virtual) {
      if (v === s || v.employeeId !== s.employeeId) continue;
      const l = this.slotLocal(v.hotelId, v.startMs, v.endMs);
      others.push({
        id: v.entryId ?? null,
        startMs: v.startMs,
        endMs: v.endMs,
        breakMinutes: v.breakMinutes,
        localDate: l.localDate,
      });
    }
    const contract = this.contractAt(emp, local.localDate);
    return checkEntry({
      entry: {
        id: s.entryId ?? null,
        hotelId: s.hotelId,
        departmentId: s.departmentId,
        shiftId: s.shiftId,
        startMs: s.startMs,
        endMs: s.endMs,
        breakMinutes: s.breakMinutes,
        ...local,
      },
      employee: {
        dateOfBirth: emp.dateOfBirth,
        active: emp.active,
        hotelIds: emp.hotelIds,
        departmentIds: emp.departmentIds,
      },
      contractActive: !!contract,
      monthlyHoursCap: contract?.monthlyHoursCap ?? null,
      others,
      absenceOnDay: this.absentOn(s.employeeId, local.localDate),
      periodClosed: this.isClosed(s.hotelId, local.localDate),
      today: localDate(this.now, hotel.tz),
      availability: this.availability.get(s.employeeId) ?? [],
      qualification: {
        requiredId: s.shiftId ? (this.shiftQualification.get(s.shiftId) ?? null) : null,
        held: this.qualifications.get(s.employeeId) ?? [],
      },
      limits: this.limits.get(s.hotelId),
      calendar: {
        sundayDates: (this.calendar.get(s.employeeId) ?? [])
          .filter((c) => c.sunday && !ignore.has(c.id) && c.date !== local.localDate)
          .map((c) => c.date),
        nightDates: (this.calendar.get(s.employeeId) ?? [])
          .filter(
            (c) =>
              c.night &&
              !ignore.has(c.id) &&
              c.date !== local.localDate &&
              c.date < local.localDate &&
              c.date >= addDays(local.localDate, -365),
          )
          .map((c) => c.date),
      },
      wishes: {
        shift: this.shiftWishes.get(s.employeeId) ?? [],
        leave: this.leaveWishes.get(s.employeeId) ?? [],
      },
      skip,
    });
  }

  /** planned working hours of the ISO week containing `date`, from loaded non-cancelled entries */
  weekMinutes(empId: number, date: string, exceptIds: number[] = []): number {
    const mon = mondayOf(date);
    const sun = addDays(mon, 6);
    return (this.entries.get(empId) ?? [])
      .filter((r) => r.shift_date >= mon && r.shift_date <= sun && !exceptIds.includes(r.id))
      .reduce(
        (a, r) =>
          a +
          workingMinutes({
            startMs: r.planned_start.getTime(),
            endMs: r.planned_end.getTime(),
            breakMinutes: r.planned_break_minutes,
          }),
        0,
      );
  }
}

export { aggregate };
