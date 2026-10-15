import type { SharedPlanDto } from '@dienst/shared';
import type { Db } from '../db';
import type { Principal } from '../lib/scope';
import { AppError } from '../lib/errors';
import { buildGrid, type GridCellOut, type GridRowOut } from './planning/grid';

/**
 * The Dienstplan as a copy for employees (to print or hand out). It is built from the planner grid, so scope and the
 * publish rules are the same, but only what the copy needs leaves the server: no warnings, drafts, changes,
 * understaffing, wishes, reasons, hours, personnel numbers or badges, and every absence is a neutral "absent".
 * A week that is not fully published (drafts or unpublished changes) is refused.
 */
export async function buildSharedPlan(
  db: Db,
  p: Principal,
  now: Date,
  hotelIds: number[],
  from: string,
): Promise<SharedPlanDto> {
  const grid = await buildGrid(db, p, now, { hotelIds, view: 'employee', range: 'week', from });
  if (grid.status !== 'published')
    throw new AppError('CONFLICT', 'The week is not fully published', { reason: 'NOT_PUBLISHED' });

  const rows = grid.rows.filter((r): r is GridRowOut & { employeeId: number } => r.kind === 'employee');
  const ids = [...new Set(rows.map((r) => r.employeeId))];
  const names = new Map(
    (ids.length
      ? await db
          .selectFrom('employee')
          .select(['employee_id', 'first_name', 'last_name'])
          .where('employee_id', 'in', ids)
          .execute()
      : []
    ).map((e) => [e.employee_id, `${e.first_name} ${e.last_name}`]),
  );
  const hotels = new Map(
    (await db.selectFrom('hotel').select(['id', 'name']).where('id', 'in', grid.hotelIds).execute()).map(
      (h) => [h.id, h.name],
    ),
  );

  const cellOut = (c: GridCellOut) => ({
    date: c.date,
    entries: c.entries
      .filter((e) => !e.isOtherHotel && e.change !== 'removed')
      .map((e) => ({ start: e.start, end: e.end, shiftName: e.shiftName ?? null })),
    absent: ((c.absenceIds as number[] | undefined) ?? []).length > 0,
  });

  const out: SharedPlanDto['hotels'] = grid.hotelIds.map((id) => ({
    id,
    name: hotels.get(id) ?? '',
    departments: [],
  }));
  for (const r of rows) {
    const cells = r.cells.map(cellOut);
    // only people who work or are away that week appear on the copy
    if (!cells.some((c) => c.entries.length || c.absent)) continue;
    const hotel = out.find((h) => h.id === (r.hotelId as number | null));
    if (!hotel) continue;
    const depId = (r.departmentId as number | null) ?? 0;
    let dep = hotel.departments.find((d) => d.id === depId);
    if (!dep) {
      dep = { id: depId, name: r.departmentName ?? '', employees: [] };
      hotel.departments.push(dep);
    }
    // a reduced row (an employee of another hotel's manager view) keeps the short display name
    dep.employees.push({ name: r.reduced ? r.label : (names.get(r.employeeId) ?? r.label), cells });
  }
  return {
    from: grid.from,
    to: grid.to,
    days: grid.days.map((d) => ({ date: d.date, holiday: (d.holiday as string | null) ?? null })),
    hotels: out.filter((h) => h.departments.length),
  };
}
