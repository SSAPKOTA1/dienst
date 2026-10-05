import { addDays, countedDays, eachDay, isoWeekday } from '@dienst/rules';
import type { Db } from '../db';
import { zonedInstant } from '../lib/time';
import { resolveHolidays } from '../services/holidays';
import { ensureAllowance } from '../services/vacation';
import { loadSample, num } from './sample';
import type { SeedResult } from './index';

/** Prototype situations: one published week, one week with drafts (Fri-Sun), absences and a pending vacation request. */
export async function seedSchedule(db: Db, r: SeedResult, now: Date) {
  const sample = loadSample();
  const week0: string = r.ids.week0;
  const hotels: Record<string, number> = r.ids.hotels;
  const shifts: Record<string, number> = r.ids.shifts;
  const empIds: Record<string, number> = r.ids.empIds;
  const adUser: number = r.ids.adUser;
  const publishedAt = new Date(now.getTime() - 5 * 86400e3);
  const hotelRows = await db.selectFrom('hotel').select(['id', 'timezone']).execute();
  const tz = new Map(hotelRows.map((h) => [h.id, h.timezone]));

  const shiftRows = await db.selectFrom('shift').selectAll().execute();
  const shiftById = new Map(shiftRows.map((s) => [s.id, s]));
  const snapshots = new Map<string, Array<Record<string, unknown>>>(); // `${hotel}:${weekStart}`

  const absence = async (
    empKey: string,
    from: string,
    to: string,
    type: string,
    status: 'approved' | 'pending',
    extra: Record<string, unknown> = {},
  ) => {
    const e = sample.EMPS.find((x) => x.id === empKey)!;
    const hk = e.h ?? 'ffm';
    const contract = await db
      .selectFrom('employee_contract')
      .select('working_weekdays')
      .where('employee_id', '=', empIds[empKey])
      .executeTakeFirstOrThrow();
    const hol = new Set((await resolveHolidays(db, hotels[hk], from, to)).keys());
    const days = countedDays(from, to, contract.working_weekdays, hol).length;
    const t = await db
      .selectFrom('absence_type')
      .selectAll()
      .where('code', '=', type)
      .executeTakeFirstOrThrow();
    const row = await db
      .insertInto('time_off')
      .values({
        employee_id: empIds[empKey],
        start_date: from,
        end_date: to,
        time_off_days: days,
        type,
        status,
        certificate_status: type === 'sick_leave' ? 'received' : null,
        counts_against_allowance: t.counts_against_allowance,
        credits_hours: t.credits_hours,
        created_by_user_id:
          status === 'pending'
            ? (
                await db
                  .selectFrom('employee')
                  .select('user_id')
                  .where('employee_id', '=', empIds[empKey])
                  .executeTakeFirstOrThrow()
              ).user_id
            : adUser,
        ...extra,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (status === 'approved' && t.counts_against_allowance) {
      const a = await ensureAllowance(db, empIds[empKey], Number(from.slice(0, 4)));
      await db
        .updateTable('employee_vacation_allowance')
        .set({ used_days: a.used_days + days })
        .where('id', '=', a.id)
        .execute();
    }
    return row.id;
  };

  for (const e of sample.EMPS) {
    const hk = e.h ?? 'ffm';
    const emp = empIds[e.id];
    for (const week of [0, 1]) {
      const monday = addDays(week0, week * 7);
      // contiguous runs of absence letters
      let run: { code: string; from: string; to: string } | null = null;
      const flush = async () => {
        if (!run) return;
        if (run.code === 'F') await absence(e.id, run.from, run.to, 'off_day', 'approved');
        else if (run.code === 'S') await absence(e.id, run.from, run.to, 'vocational_school', 'approved');
        else if (run.code === 'K' && week === 0)
          await absence(e.id, run.from, run.to, 'sick_leave', 'approved');
        else if (run.code === 'U') {
          if (week === 0) await absence(e.id, run.from, run.to, 'annual_leave', 'approved');
          else await absence(e.id, run.from, run.to, 'annual_leave', 'pending', { reason: 'Familienurlaub' });
        }
        run = null;
      };
      for (let i = 0; i < 7; i++) {
        const date = addDays(monday, i);
        const c = e.w[i];
        if ('FSKU'.includes(c)) {
          if (run && run.code === c && run.to === addDays(date, -1)) run.to = date;
          else {
            await flush();
            run = { code: c, from: date, to: date };
          }
          continue;
        }
        await flush();
        const isShift = !!sample.SH[c];
        const isOther = c === 'X';
        if (!isShift && !isOther) continue;
        const code = isOther ? 'E' : c;
        const hotelKey = isOther ? 'ber' : hk;
        const shiftId = shifts[`${hotelKey}:${code}`];
        const sh = shiftById.get(shiftId)!;
        const zone = tz.get(hotels[hotelKey])!;
        const start = zonedInstant(date, String(sh.start_time).slice(0, 5), zone);
        const endStr = String(sh.end_time).slice(0, 5);
        const end = zonedInstant(
          endStr <= String(sh.start_time).slice(0, 5) ? addDays(date, 1) : date,
          endStr,
          zone,
        );
        const draft = week === 1 && i >= 4 && !isOther;
        const row = await db
          .insertInto('schedule')
          .values({
            hotel_id: hotels[hotelKey],
            employee_id: emp,
            shift_id: shiftId,
            shift_date: date,
            planned_start: start,
            planned_end: end,
            planned_break_minutes: sh.break_duration_minutes,
            status: draft ? 'draft' : 'published',
            published_at: draft ? null : publishedAt,
            created_by_user_id: adUser,
            created_by_role: 'admin',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (!draft) {
          const key = `${hotels[hotelKey]}:${monday}`;
          const l = snapshots.get(key) ?? [];
          l.push({
            id: row.id,
            employeeId: emp,
            shiftId,
            date,
            start: start.toISOString(),
            end: end.toISOString(),
            plannedBreakMinutes: sh.break_duration_minutes,
          });
          snapshots.set(key, l);
        }
      }
      await flush();
    }
  }
  for (const [key, items] of snapshots) {
    const [hotelId, weekStart] = key.split(':');
    await db
      .insertInto('schedule_snapshot')
      .values({
        hotel_id: Number(hotelId),
        week_start: weekStart,
        snapshot: JSON.stringify(items),
        published_by_user_id: adUser,
        published_at: publishedAt,
      })
      .execute();
  }
  // week 1 snapshot must exist for every hotel even if it only holds published days
  // approved vacation from the sample (past and future)
  const VE: Array<[string, string, string]> = [
    ['jon', '2026-08-03', '2026-08-14'],
    ['piotr', '2026-11-23', '2026-11-27'],
    ['sven', '2026-10-19', '2026-10-23'],
    ['clara', '2026-12-28', '2026-12-30'],
    ['tom', '2026-07-13', '2026-07-17'],
  ];
  for (const [k, from, to] of VE) await absence(k, from, to, 'annual_leave', 'approved');
  // remaining vacation as in the sample: allocated = remaining + used - carry-over
  for (const e of sample.EMPS) {
    const a = await db
      .selectFrom('employee_vacation_allowance')
      .selectAll()
      .where('employee_id', '=', empIds[e.id])
      .where('year', '=', Number(week0.slice(0, 4)))
      .executeTakeFirstOrThrow();
    await db
      .updateTable('employee_vacation_allowance')
      .set({ allocated_days: num(e.vac) - num(e.carry) + a.used_days })
      .where('id', '=', a.id)
      .execute();
  }
  void eachDay;
  void isoWeekday;
}
