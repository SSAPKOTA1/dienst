import { workingMinutes } from '@dienst/rules';
import type { Db } from '../../db';
import { AppError, notFound } from '../../lib/errors';
import type { Principal } from '../../lib/scope';
import { PlanEnv } from './env';
import { slotFromInput } from './ops';

export interface CandidateParams {
  hotelIds: number[];
  departmentId?: number;
  date: string;
  shiftId?: number;
  start?: string;
  end?: string;
}

/** SPEC 4.17: employees of the hotel and department who could take the slot, best first. */
export async function findCandidates(db: Db, p: Principal, now: Date, prm: CandidateParams) {
  let hotelId = prm.hotelIds[0];
  let departmentId = prm.departmentId;
  if (prm.shiftId) {
    const s = await db
      .selectFrom('shift')
      .select(['hotel_id', 'department_id'])
      .where('id', '=', prm.shiftId)
      .executeTakeFirst();
    if (!s) throw notFound('Shift');
    hotelId = s.hotel_id;
    departmentId = s.department_id;
  } else if (departmentId) {
    const d = await db
      .selectFrom('department')
      .select('hotel_id')
      .where('id', '=', departmentId)
      .executeTakeFirst();
    if (!d) throw notFound('Department');
    hotelId = d.hotel_id;
  }
  if (!hotelId) throw new AppError('VALIDATION', 'hotelIds, departmentId or shiftId is required');
  p.scope.assertHotel(hotelId);
  const pool = await db
    .selectFrom('employee_hotel as eh')
    .innerJoin('employee as e', 'e.employee_id', 'eh.employee_id')
    .select('e.employee_id')
    .where('eh.hotel_id', '=', hotelId)
    .where('e.status', '=', 'active')
    .execute();
  let ids = pool.map((x) => x.employee_id);
  if (departmentId && ids.length) {
    const inDept = await db
      .selectFrom('employee_department')
      .select('employee_id')
      .where('department_id', '=', departmentId)
      .where('employee_id', 'in', ids)
      .execute();
    ids = inDept.map((x) => x.employee_id);
  }
  const env = await PlanEnv.create(db, now, { employeeIds: ids, from: prm.date, to: prm.date });
  const slot = await slotFromInput(db, env, {
    hotelId,
    shiftId: prm.shiftId,
    date: prm.date,
    start: prm.start,
    end: prm.end,
  });
  const out = [];
  for (const id of ids) {
    const e = env.employees.get(id)!;
    const v = env.check({
      employeeId: id,
      hotelId,
      shiftId: slot.shiftId,
      departmentId: departmentId ?? slot.departmentId,
      startMs: slot.startMs,
      endMs: slot.endMs,
      breakMinutes: slot.breakMinutes,
    });
    if (v.some((x) => x.severity === 'block')) continue;
    const contract = env.contractAt(e, prm.date);
    const weekly = contract
      ? (contract.weeklyTarget ??
        (contract.monthlyTarget != null ? (contract.monthlyTarget * 12) / 52 : null))
      : null;
    const weekMin = env.weekMinutes(id, prm.date);
    out.push({
      employeeId: id,
      displayName: e.displayName,
      hotelName: env.hotels.get(e.primaryHotelId)?.name ?? '',
      isFloater: e.isFloater,
      weekHours: Math.round((weekMin / 60) * 10) / 10,
      targetHours:
        weekly != null && !(p.role === 'manager' && !p.scope.canHotel(e.primaryHotelId))
          ? Math.round(weekly * 10) / 10
          : null,
      warnings: v.map((x) => ({
        code: x.code,
        severity: x.severity,
        message: x.message,
        details: x.details,
      })),
      _w: weekMin,
    });
  }
  out.sort(
    (a, b) =>
      a.warnings.length - b.warnings.length || a._w - b._w || a.displayName.localeCompare(b.displayName),
  );
  void workingMinutes;
  return out.map(({ _w, ...rest }) => rest);
}
