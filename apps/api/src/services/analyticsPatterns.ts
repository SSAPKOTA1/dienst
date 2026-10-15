import {
  LATE_GRACE_MINUTES,
  LONG_STAY_MINUTES,
  PATTERN_MIN_GROUP,
  PATTERN_MIN_GROUP_SICK,
  type Feature,
  type PatternGranularity,
  type PatternGroup,
  type PatternLevel,
  type PatternMetric,
  type PatternsDto,
} from '@dienst/shared';
import { addDays, isoWeekday, mondayOf } from '@dienst/rules';
import type { Db } from '../db';
import { featureEnabled } from './features';

/**
 * Patterns over time for sickness, overtime, late arrivals and long stays, as TOTALS for a hotel, a department or a
 * shift. Never per employee. A figure built from fewer people than the minimum group size is not returned (null);
 * sickness needs a bigger group. Late arrivals and long stays are only returned for companies that switched the
 * matching feature on.
 *
 * Definitions:
 *  - sick: share of planned shifts that were cancelled because of sickness (cancel_reason = sick)
 *  - overtime: hours paid above the planned working time (approved punches of planned shifts only)
 *  - late: share of planned punches whose clock-in was later than planned start + LATE_GRACE_MINUTES
 *  - long stay: share of planned punches whose clock-out was later than planned end + LONG_STAY_MINUTES
 * Only approved punch records count. The suppression protects against showing small-group figures; it does not
 * stop an admin from combining levels, and admins can see the individual records anyway.
 */
interface Acc {
  /** per bucket: employees seen, counts */
  planned: Map<string, { emps: Set<string>; n: number }>;
  sick: Map<string, number>;
  punch: Map<string, { emps: Set<number>; n: number; overtimeH: number; late: number; long: number }>;
  weekday: {
    plannedN: number[];
    sick: number[];
    punchN: number[];
    overtimeH: number[];
    late: number[];
    long: number[];
    plannedEmps: Set<number>[];
    punchEmps: Set<number>[];
  };
}

const bucketOf = (date: string, g: PatternGranularity) => (g === 'month' ? date.slice(0, 7) : mondayOf(date));
const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (a: number, b: number) => (b > 0 ? round1((a / b) * 100) : null);

function periodsOf(from: string, to: string, g: PatternGranularity): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const b = bucketOf(d, g);
    if (out[out.length - 1] !== b) out.push(b);
  }
  return out;
}

export async function buildPatterns(
  db: Db,
  hotelIds: number[],
  from: string,
  to: string,
  level: PatternLevel,
  granularity: PatternGranularity,
): Promise<PatternsDto> {
  const periods = periodsOf(from, to, granularity);
  const base: PatternsDto = {
    from,
    to,
    level,
    granularity,
    periods,
    thresholds: { min: PATTERN_MIN_GROUP, minSick: PATTERN_MIN_GROUP_SICK },
    groups: [],
  };
  if (!hotelIds.length) return base;

  const hotels = new Map(
    (
      await db.selectFrom('hotel').select(['id', 'name', 'company_id']).where('id', 'in', hotelIds).execute()
    ).map((h) => [h.id, h]),
  );
  const depts = new Map(
    (
      await db.selectFrom('department').select(['id', 'name']).where('hotel_id', 'in', hotelIds).execute()
    ).map((d) => [d.id, d.name]),
  );
  const enabled = new Map<string, boolean>();
  const on = async (companyId: number, f: Feature) => {
    const k = `${companyId}:${f}`;
    if (!enabled.has(k)) enabled.set(k, await featureEnabled(db, companyId, f));
    return enabled.get(k)!;
  };

  // planned shifts of the range (any status) for sickness and for the group sizes
  const sched = await db
    .selectFrom('schedule as s')
    .leftJoin('shift as sh', 'sh.id', 's.shift_id')
    .innerJoin('employee as e', 'e.employee_id', 's.employee_id')
    .select([
      's.hotel_id',
      's.employee_id',
      's.shift_date',
      's.status',
      's.cancel_reason',
      's.shift_id',
      'sh.department_id as shift_department_id',
      'sh.name as shift_name',
      'e.primary_department_id',
    ])
    .where('s.hotel_id', 'in', hotelIds)
    .where('s.shift_date', '>=', from)
    .where('s.shift_date', '<=', to)
    .execute();
  // approved punches of the range
  const punches = await db
    .selectFrom('punch_record as p')
    .leftJoin('schedule as s', 's.id', 'p.schedule_id')
    .leftJoin('shift as sh', 'sh.id', 's.shift_id')
    .innerJoin('employee as e', 'e.employee_id', 'p.employee_id')
    .select([
      'p.hotel_id',
      'p.employee_id',
      'p.shift_date',
      'p.is_unplanned',
      'p.planned_start',
      'p.planned_end',
      'p.paid_hours',
      'p.required_break_minutes',
      'p.start_variation_minutes',
      'p.end_variation_minutes',
      's.shift_id',
      'sh.department_id as shift_department_id',
      'sh.name as shift_name',
      'e.primary_department_id',
    ])
    .where('p.hotel_id', 'in', hotelIds)
    .where('p.approval_status', '=', 'approved')
    .where('p.shift_date', '>=', from)
    .where('p.shift_date', '<=', to)
    .execute();

  const groups = new Map<string, { name: string; hotelId: number; acc: Acc }>();
  const groupOf = (
    hotelId: number,
    deptId: number | null,
    shiftId: number | null,
    shiftName: string | null,
  ) => {
    const hotel = hotels.get(hotelId);
    if (!hotel) return null;
    let key: string;
    let name: string;
    if (level === 'hotel') {
      key = `h:${hotelId}`;
      name = hotel.name;
    } else if (level === 'department') {
      const id = deptId ?? 0;
      key = `d:${id}`;
      name = depts.get(id) ?? '–';
    } else {
      key = `s:${shiftId ?? `0:${hotelId}`}`;
      name = shiftName ?? 'Ungeplant';
    }
    let g = groups.get(key);
    if (!g) {
      g = {
        name,
        hotelId,
        acc: {
          planned: new Map(),
          sick: new Map(),
          punch: new Map(),
          weekday: {
            plannedN: Array(7).fill(0),
            sick: Array(7).fill(0),
            punchN: Array(7).fill(0),
            overtimeH: Array(7).fill(0),
            late: Array(7).fill(0),
            long: Array(7).fill(0),
            plannedEmps: Array.from({ length: 7 }, () => new Set<number>()),
            punchEmps: Array.from({ length: 7 }, () => new Set<number>()),
          },
        },
      };
      groups.set(key, g);
    }
    return g;
  };

  for (const r of sched) {
    const g = groupOf(r.hotel_id, r.shift_department_id ?? r.primary_department_id, r.shift_id, r.shift_name);
    if (!g) continue;
    const b = bucketOf(r.shift_date, granularity);
    const wd = isoWeekday(r.shift_date) - 1;
    const p = g.acc.planned.get(b) ?? { emps: new Set<string>(), n: 0 };
    p.emps.add(String(r.employee_id));
    p.n += 1;
    g.acc.planned.set(b, p);
    g.acc.weekday.plannedN[wd]! += 1;
    g.acc.weekday.plannedEmps[wd]!.add(r.employee_id);
    if (r.status === 'cancelled' && r.cancel_reason === 'sick') {
      g.acc.sick.set(b, (g.acc.sick.get(b) ?? 0) + 1);
      g.acc.weekday.sick[wd]! += 1;
    }
  }
  for (const r of punches) {
    const g = groupOf(r.hotel_id, r.shift_department_id ?? r.primary_department_id, r.shift_id, r.shift_name);
    if (!g) continue;
    const b = bucketOf(r.shift_date, granularity);
    const wd = isoWeekday(r.shift_date) - 1;
    const p = g.acc.punch.get(b) ?? { emps: new Set<number>(), n: 0, overtimeH: 0, late: 0, long: 0 };
    p.emps.add(r.employee_id);
    g.acc.weekday.punchEmps[wd]!.add(r.employee_id);
    const planned = !r.is_unplanned && r.planned_start && r.planned_end;
    if (planned) {
      p.n += 1;
      g.acc.weekday.punchN[wd]! += 1;
      const plannedNet =
        (r.planned_end!.getTime() - r.planned_start!.getTime()) / 60000 - (r.required_break_minutes ?? 0);
      const over = Math.max(0, Number(r.paid_hours ?? 0) * 60 - plannedNet) / 60;
      p.overtimeH += over;
      g.acc.weekday.overtimeH[wd]! += over;
      if ((r.start_variation_minutes ?? 0) > LATE_GRACE_MINUTES) {
        p.late += 1;
        g.acc.weekday.late[wd]! += 1;
      }
      if ((r.end_variation_minutes ?? 0) > LONG_STAY_MINUTES) {
        p.long += 1;
        g.acc.weekday.long[wd]! += 1;
      }
    }
    g.acc.punch.set(b, p);
  }

  const out: PatternGroup[] = [];
  for (const [key, g] of groups) {
    const company = hotels.get(g.hotelId)!.company_id;
    const lateOn = await on(company, 'analytics_late');
    const longOn = await on(company, 'analytics_long_stay');
    const a = g.acc;
    const wdSick = a.weekday.plannedEmps.map((s) => s.size);
    const wdPunch = a.weekday.punchEmps.map((s) => s.size);
    const guard = (n: number, min: number, v: number | null) => (n >= min ? v : null);
    const sum = (m: Map<string, number>) => [...m.values()].reduce((x, y) => x + y, 0);
    const plannedAll = [...a.planned.values()].reduce((x, y) => x + y.n, 0);
    const plannedPeople = new Set([...a.planned.values()].flatMap((x) => [...x.emps])).size;
    const punchAll = [...a.punch.values()].reduce((x, y) => x + y.n, 0);

    const sick: PatternMetric = {
      unit: 'percent',
      values: periods.map((p) => {
        const pl = a.planned.get(p);
        return pl ? guard(pl.emps.size, PATTERN_MIN_GROUP_SICK, pct(a.sick.get(p) ?? 0, pl.n)) : null;
      }),
      total: guard(plannedPeople, PATTERN_MIN_GROUP_SICK, pct(sum(a.sick), plannedAll)),
      byWeekday: a.weekday.sick.map((s, i) =>
        guard(wdSick[i]!, PATTERN_MIN_GROUP_SICK, pct(s, a.weekday.plannedN[i]!)),
      ),
    };
    const overtime: PatternMetric = {
      unit: 'hours',
      values: periods.map((p) => {
        const x = a.punch.get(p);
        return x ? guard(x.emps.size, PATTERN_MIN_GROUP, round1(x.overtimeH)) : null;
      }),
      total: guard(
        new Set([...a.punch.values()].flatMap((x) => [...x.emps])).size,
        PATTERN_MIN_GROUP,
        round1([...a.punch.values()].reduce((x, y) => x + y.overtimeH, 0)),
      ),
      byWeekday: a.weekday.overtimeH.map((h, i) => guard(wdPunch[i]!, PATTERN_MIN_GROUP, round1(h))),
    };
    const rate = (pick: 'late' | 'long'): PatternMetric => ({
      unit: 'percent',
      values: periods.map((p) => {
        const x = a.punch.get(p);
        return x ? guard(x.emps.size, PATTERN_MIN_GROUP, pct(x[pick], x.n)) : null;
      }),
      total: guard(
        new Set([...a.punch.values()].flatMap((x) => [...x.emps])).size,
        PATTERN_MIN_GROUP,
        pct(
          [...a.punch.values()].reduce((x, y) => x + y[pick], 0),
          punchAll,
        ),
      ),
      byWeekday: a.weekday[pick].map((c, i) =>
        guard(wdPunch[i]!, PATTERN_MIN_GROUP, pct(c, a.weekday.punchN[i]!)),
      ),
    });
    out.push({
      key,
      name: g.name,
      hotelName: hotels.get(g.hotelId)!.name,
      metrics: { sick, overtime, late: lateOn ? rate('late') : null, longStay: longOn ? rate('long') : null },
    });
  }
  out.sort((x, y) => x.hotelName.localeCompare(y.hotelName) || x.name.localeCompare(y.name));
  return { ...base, groups: out };
}
