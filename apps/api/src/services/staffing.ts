import { resolveRequired } from '@dienst/rules';
import type { DbOrTrx } from '../db';

export interface Staffing {
  weekdayDefaults: Map<number, number>;
  overrides: Map<string, number>;
}

/** Loads staffing requirements for several shifts at once. */
export async function loadStaffing(db: DbOrTrx, shiftIds: number[]): Promise<Map<number, Staffing>> {
  const out = new Map<number, Staffing>();
  for (const id of shiftIds) out.set(id, { weekdayDefaults: new Map(), overrides: new Map() });
  if (!shiftIds.length) return out;
  const rows = await db
    .selectFrom('shift_staffing_requirement')
    .selectAll()
    .where('shift_id', 'in', shiftIds)
    .execute();
  for (const r of rows) {
    const s = out.get(r.shift_id)!;
    if (r.weekday != null) s.weekdayDefaults.set(r.weekday, r.required_headcount);
    if (r.on_date != null) s.overrides.set(r.on_date, r.required_headcount);
  }
  return out;
}

export const requiredOn = (s: Staffing | undefined, date: string): number =>
  s ? resolveRequired(date, s.weekdayDefaults, s.overrides) : 0;
