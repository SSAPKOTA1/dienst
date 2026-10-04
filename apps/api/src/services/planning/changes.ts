import { sql } from 'kysely';
import { addDays, mondayOf, openSlots as openSlotsFn } from '@dienst/rules';
import type { Db, DbOrTrx, Trx } from '../../db';
import { AppError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { localDate } from '../../lib/time';
import { loadStaffing, requiredOn } from '../staffing';
import { PlanEnv, type EntryRow } from './env';
import {
  checkPlan,
  enforce,
  notifyEmployee,
  rowOut,
  shiftToDate,
  slotFromInput,
  creatorRole,
  type Ctx,
  type Plan,
} from './ops';
import type { Subject } from './env';

export interface SnapItem {
  id: number;
  employeeId: number;
  shiftId: number | null;
  date: string;
  start: string;
  end: string;
  plannedBreakMinutes: number;
}

export type ChangeType = 'new' | 'changed' | 'removed';
export interface Change {
  entryId: number;
  type: ChangeType;
  employeeId: number;
  displayName: string;
  hotelId: number;
  date: string;
  from: { employeeId: number; date: string; start: string; end: string; breakMinutes: number } | null;
  to: { employeeId: number; date: string; start: string; end: string; breakMinutes: number } | null;
}

const weekMonday = (d: string) => mondayOf(d);
export const weeksIn = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let m = weekMonday(from); m <= to; m = addDays(m, 7)) out.push(m);
  return out;
};

const toSnap = (r: EntryRow): SnapItem => ({
  id: r.id,
  employeeId: r.employee_id,
  shiftId: r.shift_id,
  date: r.shift_date,
  start: r.planned_start.toISOString(),
  end: r.planned_end.toISOString(),
  plannedBreakMinutes: r.planned_break_minutes,
});

export async function latestSnapshot(db: DbOrTrx, hotelId: number, weekStart: string) {
  return db
    .selectFrom('schedule_snapshot')
    .selectAll()
    .where('hotel_id', '=', hotelId)
    .where('week_start', '=', weekStart)
    .orderBy('published_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
}

async function weekRows(db: DbOrTrx, hotelId: number, weekStart: string): Promise<EntryRow[]> {
  return (await db
    .selectFrom('schedule')
    .selectAll()
    .where('hotel_id', '=', hotelId)
    .where('shift_date', '>=', weekStart)
    .where('shift_date', '<=', addDays(weekStart, 6))
    .orderBy('id')
    .execute()) as EntryRow[];
}

/** SPEC 4.18: changes of one hotel week against its latest snapshot. */
export async function changesFor(
  db: DbOrTrx,
  hotelId: number,
  weekStart: string,
  names?: Map<number, string>,
): Promise<Change[]> {
  const rows = await weekRows(db, hotelId, weekStart);
  const snapRow = await latestSnapshot(db, hotelId, weekStart);
  const snap = new Map<number, SnapItem>(
    ((snapRow?.snapshot ?? []) as unknown as SnapItem[]).map((s) => [s.id, s]),
  );
  const empIds = [
    ...new Set([...rows.map((r) => r.employee_id), ...[...snap.values()].map((s) => s.employeeId)]),
  ];
  const nameMap = names ?? new Map<number, string>();
  const missing = empIds.filter((i) => !nameMap.has(i));
  if (missing.length)
    for (const e of await db
      .selectFrom('employee')
      .select(['employee_id', 'display_name'])
      .where('employee_id', 'in', missing)
      .execute())
      nameMap.set(e.employee_id, e.display_name ?? '');
  const out: Change[] = [];
  const ent = (e: {
    employeeId: number;
    date: string;
    start: string;
    end: string;
    plannedBreakMinutes: number;
  }) => ({
    employeeId: e.employeeId,
    date: e.date,
    start: e.start,
    end: e.end,
    breakMinutes: e.plannedBreakMinutes,
  });
  const seen = new Set<number>();
  for (const r of rows) {
    seen.add(r.id);
    const s = snap.get(r.id);
    if (r.status === 'cancelled') {
      if (s)
        out.push({
          entryId: r.id,
          type: 'removed',
          employeeId: s.employeeId,
          displayName: nameMap.get(s.employeeId) ?? '',
          hotelId,
          date: s.date,
          from: ent(s),
          to: null,
        });
      continue;
    }
    const cur = toSnap(r);
    if (!s)
      out.push({
        entryId: r.id,
        type: 'new',
        employeeId: r.employee_id,
        displayName: nameMap.get(r.employee_id) ?? '',
        hotelId,
        date: r.shift_date,
        from: null,
        to: ent(cur),
      });
    else if (
      s.employeeId !== cur.employeeId ||
      s.date !== cur.date ||
      s.plannedBreakMinutes !== cur.plannedBreakMinutes ||
      Date.parse(s.start) !== Date.parse(cur.start) ||
      Date.parse(s.end) !== Date.parse(cur.end)
    )
      out.push({
        entryId: r.id,
        type: 'changed',
        employeeId: r.employee_id,
        displayName: nameMap.get(r.employee_id) ?? '',
        hotelId,
        date: r.shift_date,
        from: ent(s),
        to: ent(cur),
      });
  }
  // snapshot entries whose row moved to another week or hotel, or was deleted
  for (const s of snap.values()) {
    if (seen.has(s.id)) continue;
    out.push({
      entryId: s.id,
      type: 'removed',
      employeeId: s.employeeId,
      displayName: nameMap.get(s.employeeId) ?? '',
      hotelId,
      date: s.date,
      from: ent(s),
      to: null,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.displayName.localeCompare(b.displayName));
}

export async function changesInRange(
  db: DbOrTrx,
  hotelIds: number[],
  from: string,
  to: string,
): Promise<Change[]> {
  const out: Change[] = [];
  const names = new Map<number, string>();
  for (const h of hotelIds)
    for (const w of weeksIn(from, to)) out.push(...(await changesFor(db, h, w, names)));
  return out;
}

// ---------------------------------------------------------------------------------------------
// open slots (shared with the grid)

export async function openSlotsTotal(
  db: DbOrTrx,
  hotelIds: number[],
  from: string,
  to: string,
): Promise<number> {
  if (!hotelIds.length) return 0;
  const shifts = await db.selectFrom('shift').select(['id']).where('hotel_id', 'in', hotelIds).execute();
  const staffing = await loadStaffing(
    db,
    shifts.map((s) => s.id),
  );
  const rows = await db
    .selectFrom('schedule')
    .select(['shift_id', 'shift_date', 'employee_id'])
    .where('hotel_id', 'in', hotelIds)
    .where('shift_date', '>=', from)
    .where('shift_date', '<=', to)
    .where('status', '<>', 'cancelled')
    .where('shift_id', 'is not', null)
    .execute();
  let open = 0;
  for (const s of shifts) {
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const assigned = rows.filter((r) => r.shift_id === s.id && r.shift_date === d).length;
      open += openSlotsFn(requiredOn(staffing.get(s.id), d), assigned);
    }
  }
  return open;
}

// ---------------------------------------------------------------------------------------------
// publish

export async function publishWeeks(ctx: Ctx, hotelIds: number[], from: string, to: string) {
  const { trx, principal: p } = ctx;
  for (const h of hotelIds) p.scope.assertHotel(h);
  const env = await PlanEnv.create(trx, ctx.now, { employeeIds: [], from, to });
  const weeks = weeksIn(from, to);
  const names = new Map<number, string>();
  let changedCount = 0;
  let published = 0;
  const perHotel: Array<{ hotelId: number; weekStart: string; changes: number }> = [];
  for (const hotelId of hotelIds) {
    const hotel = env.hotel(hotelId);
    for (const week of weeks) {
      const changes = await changesFor(trx, hotelId, week, names);
      const lastSnap = await latestSnapshot(trx, hotelId, week);
      if (changes.some((c) => env.isClosed(hotelId, c.date)))
        throw new AppError('PERIOD_CLOSED', 'The payroll period is closed', { weekStart: week, hotelId });
      const hasDrafts = !!(await trx
        .selectFrom('schedule')
        .select('id')
        .where('hotel_id', '=', hotelId)
        .where('shift_date', '>=', week)
        .where('shift_date', '<=', addDays(week, 6))
        .where('status', '=', 'draft')
        .limit(1)
        .executeTakeFirst());
      if (!changes.length && !hasDrafts && lastSnap) continue;
      const upd = await trx
        .updateTable('schedule')
        .set({ status: 'published', published_at: ctx.now, updated_at: ctx.now })
        .where('hotel_id', '=', hotelId)
        .where('shift_date', '>=', week)
        .where('shift_date', '<=', addDays(week, 6))
        .where('status', '=', 'draft')
        .returning('id')
        .execute();
      published += upd.length;
      const rows = (await weekRows(trx, hotelId, week)).filter((r) => r.status !== 'cancelled');
      await trx
        .insertInto('schedule_snapshot')
        .values({
          hotel_id: hotelId,
          week_start: week,
          snapshot: JSON.stringify(rows.map(toSnap)),
          published_by_user_id: p.userId,
          published_at: ctx.now,
        })
        .execute();

      // notifications: new-only -> schedule_published, any changed/removed -> schedule_changed (dedupe against live notices)
      const already = new Set<number>();
      if (lastSnap) {
        const prior = await trx
          .selectFrom('notification')
          .select('payload')
          .where('kind', '=', 'schedule_changed')
          .where('created_at', '>=', lastSnap.published_at)
          .execute();
        for (const n of prior) {
          const pl = n.payload as { entryId?: number; entryIds?: number[] } | null;
          if (pl?.entryId) already.add(pl.entryId);
          pl?.entryIds?.forEach((i) => already.add(i));
        }
      }
      const byEmp = new Map<number, Change[]>();
      for (const c of changes) {
        if (c.type !== 'new' && already.has(c.entryId)) continue;
        byEmp.set(c.employeeId, [...(byEmp.get(c.employeeId) ?? []), c]);
      }
      for (const [empId, list] of byEmp) {
        const e = await trx
          .selectFrom('employee')
          .select(['employee_id', 'user_id'])
          .where('employee_id', '=', empId)
          .executeTakeFirst();
        if (!e) continue;
        const kind = list.some((c) => c.type !== 'new') ? 'schedule_changed' : 'schedule_published';
        await notifyEmployee(trx, { id: e.employee_id, userId: e.user_id }, kind, {
          hotelId,
          weekStart: week,
          entryIds: list.map((c) => c.entryId),
          counts: {
            new: list.filter((c) => c.type === 'new').length,
            changed: list.filter((c) => c.type === 'changed').length,
            removed: list.filter((c) => c.type === 'removed').length,
          },
        });
      }
      changedCount += changes.length;
      perHotel.push({ hotelId, weekStart: week, changes: changes.length });
      await audit(trx, ctx.actor, {
        action: 'schedule_published',
        entityType: 'hotel',
        entityId: hotelId,
        hotelId,
        companyId: hotel.companyId,
        new: { weekStart: week, changes: changes.length, published: upd.length },
      });
    }
  }
  const openSlots = await openSlotsTotal(
    trx,
    hotelIds,
    weeks[0] ?? from,
    addDays(weeks[weeks.length - 1] ?? to, 6),
  );
  return { published, changedCount, openSlots, weeks: perHotel };
}

// ---------------------------------------------------------------------------------------------
// revert and clear

export async function revertChanges(
  ctx: Ctx,
  hotelIds: number[],
  from: string,
  to: string,
  entryId?: number,
) {
  const { trx, principal: p } = ctx;
  for (const h of hotelIds) p.scope.assertHotel(h);
  const env = await PlanEnv.create(trx, ctx.now, { employeeIds: [], from, to });
  let changes = await changesInRange(trx, hotelIds, from, to);
  if (entryId !== undefined) {
    changes = changes.filter((c) => c.entryId === entryId);
    if (!changes.length) throw new AppError('NOT_FOUND', 'The entry has no unpublished change');
  }
  const done = { deleted: 0, restored: 0, reset: 0 };
  const skipped: Array<{ entryId: number; reason: string }> = [];
  let sp = 0;
  for (const c of changes) {
    const today = env.today(c.hotelId);
    const days = [c.date, c.from?.date].filter(Boolean) as string[];
    if (days.some((d) => d < today)) {
      if (entryId !== undefined)
        throw new AppError('RULE_BLOCKED', 'Past days cannot be reverted', {
          violations: [
            {
              code: 'PAST_DAY',
              severity: 'block',
              message: 'The day is in the past',
              details: { date: c.date },
            },
          ],
        });
      skipped.push({ entryId: c.entryId, reason: 'PAST_DAY' });
      continue;
    }
    if (days.some((d) => env.isClosed(c.hotelId, d))) {
      skipped.push({ entryId: c.entryId, reason: 'PERIOD_CLOSED' });
      continue;
    }
    if (c.type === 'new') {
      await trx.deleteFrom('schedule').where('id', '=', c.entryId).execute();
      done.deleted++;
      continue;
    }
    const row = (await trx
      .selectFrom('schedule')
      .selectAll()
      .where('id', '=', c.entryId)
      .executeTakeFirst()) as EntryRow | undefined;
    if (!row) continue;
    if (c.type === 'removed' && row.time_off_id) {
      skipped.push({ entryId: c.entryId, reason: 'ABSENCE' });
      continue;
    }
    const snapRow = await latestSnapshot(trx, c.hotelId, mondayOf(c.from!.date));
    const item = ((snapRow?.snapshot ?? []) as unknown as SnapItem[]).find((s) => s.id === c.entryId);
    if (!item) continue;
    const name = `sp${sp++}`;
    await sql.raw(`SAVEPOINT ${name}`).execute(trx);
    try {
      await trx
        .updateTable('schedule')
        .set({
          employee_id: item.employeeId,
          shift_id: item.shiftId,
          shift_date: item.date,
          planned_start: new Date(item.start),
          planned_end: new Date(item.end),
          planned_break_minutes: item.plannedBreakMinutes,
          status: 'published',
          cancel_reason: null,
          version: row.version + 1,
          updated_at: ctx.now,
        })
        .where('id', '=', row.id)
        .execute();
      await sql.raw(`RELEASE SAVEPOINT ${name}`).execute(trx);
      if (c.type === 'removed') done.restored++;
      else done.reset++;
    } catch (e) {
      await sql.raw(`ROLLBACK TO SAVEPOINT ${name}`).execute(trx);
      if ((e as { code?: string }).code !== '23P01') throw e;
      skipped.push({ entryId: c.entryId, reason: 'OVERLAP' });
    }
  }
  const hotel = hotelIds[0] ? env.hotel(hotelIds[0]) : null;
  await audit(trx, ctx.actor, {
    action: 'schedule_reverted',
    entityType: 'schedule',
    entityId: entryId ?? null,
    hotelId: hotelIds[0] ?? null,
    companyId: hotel?.companyId ?? null,
    new: { ...done, skipped: skipped.length, from, to },
  });
  return { ...done, skipped };
}

export async function clearWeek(ctx: Ctx, hotelIds: number[], from: string, to: string) {
  const { trx, principal: p } = ctx;
  for (const h of hotelIds) p.scope.assertHotel(h);
  const env = await PlanEnv.create(trx, ctx.now, { employeeIds: [], from, to });
  let deleted = 0;
  let cancelledPublished = 0;
  const notify = new Map<number, number[]>();
  for (const hotelId of hotelIds) {
    const today = env.today(hotelId);
    const rows = (await trx
      .selectFrom('schedule')
      .selectAll()
      .where('hotel_id', '=', hotelId)
      .where('shift_date', '>=', from < today ? today : from)
      .where('shift_date', '<=', to)
      .where('status', '<>', 'cancelled')
      .execute()) as EntryRow[];
    for (const r of rows) {
      if (env.isClosed(hotelId, r.shift_date)) continue;
      if (r.status === 'draft') {
        await trx.deleteFrom('schedule').where('id', '=', r.id).execute();
        deleted++;
      } else {
        await trx
          .updateTable('schedule')
          .set({ status: 'cancelled', cancel_reason: 'changed', version: r.version + 1, updated_at: ctx.now })
          .where('id', '=', r.id)
          .execute();
        cancelledPublished++;
        notify.set(r.employee_id, [...(notify.get(r.employee_id) ?? []), r.id]);
      }
    }
    await audit(trx, ctx.actor, {
      action: 'schedule_cleared',
      entityType: 'hotel',
      entityId: hotelId,
      hotelId,
      companyId: env.hotel(hotelId).companyId,
      new: { from, to, deleted, cancelledPublished },
    });
  }
  for (const [empId, ids] of notify) {
    const e = await trx
      .selectFrom('employee')
      .select(['employee_id', 'user_id'])
      .where('employee_id', '=', empId)
      .executeTakeFirst();
    if (e)
      await notifyEmployee(trx, { id: e.employee_id, userId: e.user_id }, 'schedule_changed', {
        entryIds: ids,
        change: 'removed',
      });
  }
  return { deleted, cancelledPublished };
}

// ---------------------------------------------------------------------------------------------
// copy a week

export async function copyWeek(
  ctx: Ctx,
  hotelIds: number[],
  departmentIds: number[] | undefined,
  fromWeek: string,
  toWeek: string,
) {
  const { trx, principal: p } = ctx;
  for (const h of hotelIds) p.scope.assertHotel(h);
  const fromMonday = mondayOf(fromWeek);
  const toMonday = mondayOf(toWeek);
  const offset = Math.round((Date.parse(toMonday) - Date.parse(fromMonday)) / 86400000);
  let q = trx
    .selectFrom('schedule as s')
    .leftJoin('shift as sh', 'sh.id', 's.shift_id')
    .selectAll('s')
    .select('sh.department_id as dept')
    .where('s.hotel_id', 'in', hotelIds)
    .where('s.shift_date', '>=', fromMonday)
    .where('s.shift_date', '<=', addDays(fromMonday, 6))
    .where('s.status', '<>', 'cancelled')
    .orderBy('s.shift_date')
    .orderBy('s.id');
  if (departmentIds?.length) q = q.where('sh.department_id', 'in', departmentIds);
  const rows = (await q.execute()) as unknown as Array<EntryRow & { dept: number | null }>;
  const env = await PlanEnv.create(trx, ctx.now, {
    employeeIds: rows.map((r) => r.employee_id),
    from: toMonday,
    to: addDays(toMonday, 6),
  });
  const created: number[] = [];
  const skipped: Array<{
    entryId: number;
    employeeId: number;
    date: string;
    codes: string[];
    violations: unknown[];
  }> = [];
  for (const r of rows) {
    const date = addDays(r.shift_date, offset);
    const emp = env.employees.get(r.employee_id);
    if (!emp) continue;
    const t = shiftToDate(env, r, date);
    const subject: Subject = {
      employeeId: emp.id,
      hotelId: r.hotel_id,
      shiftId: r.shift_id,
      departmentId: r.dept ?? null,
      startMs: t.startMs,
      endMs: t.endMs,
      breakMinutes: r.planned_break_minutes,
    };
    const violations = checkPlan(env, { subjects: [subject] } as Plan);
    let blocked = violations.some((v) => v.severity === 'block' || v.severity === 'needs_reason');
    if (!blocked) {
      try {
        enforce(violations, p, {});
      } catch {
        blocked = true;
      }
    }
    if (blocked) {
      skipped.push({
        entryId: r.id,
        employeeId: emp.id,
        date,
        codes: violations.filter((v) => v.severity !== 'warn').map((v) => v.code),
        violations,
      });
      continue;
    }
    const ins = await trx
      .insertInto('schedule')
      .values({
        hotel_id: r.hotel_id,
        employee_id: emp.id,
        shift_id: r.shift_id,
        shift_date: date,
        planned_start: new Date(t.startMs),
        planned_end: new Date(t.endMs),
        planned_break_minutes: r.planned_break_minutes,
        status: 'draft',
        created_by_user_id: p.userId,
        created_by_role: creatorRole(p),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    env.addEntry(ins as EntryRow);
    created.push(ins.id);
  }
  const hotelId = hotelIds[0];
  await audit(trx, ctx.actor, {
    action: 'schedule_week_copied',
    entityType: 'hotel',
    entityId: hotelId,
    hotelId,
    companyId: env.hotel(hotelId).companyId,
    new: { fromWeek: fromMonday, toWeek: toMonday, created: created.length, skipped: skipped.length },
  });
  return { created: created.length, skipped };
}

export { rowOut, slotFromInput, localDate };
export type { Db, Trx, Ctx };
