import type { DbOrTrx } from '../db';

/** Resolved public holidays of a hotel in [from, to]: hotel > company > state > national (SPEC 3). */
export interface HolidayInfo {
  id: number;
  name: string;
  scope: string;
}

export async function resolveHolidayRows(
  db: DbOrTrx,
  hotelId: number,
  from: string,
  to: string,
): Promise<Map<string, HolidayInfo>> {
  const hotel = await db
    .selectFrom('hotel')
    .select(['company_id', 'federal_state'])
    .where('id', '=', hotelId)
    .executeTakeFirst();
  if (!hotel) return new Map();
  const rows = await db
    .selectFrom('public_holiday')
    .selectAll()
    .where('date', '>=', from)
    .where('date', '<=', to)
    .where((eb) =>
      eb.or([
        eb('scope', '=', 'national'),
        eb.and([eb('scope', '=', 'state'), eb('federal_state', '=', hotel.federal_state ?? '')]),
        eb.and([eb('scope', '=', 'company'), eb('company_id', '=', hotel.company_id)]),
        eb.and([eb('scope', '=', 'hotel'), eb('hotel_id', '=', hotelId)]),
      ]),
    )
    .execute();
  const rank = { national: 0, state: 1, company: 2, hotel: 3 } as const;
  const best = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = best.get(r.date);
    if (!cur || rank[r.scope as keyof typeof rank] >= rank[cur.scope as keyof typeof rank])
      best.set(r.date, r);
  }
  const out = new Map<string, HolidayInfo>();
  for (const [d, r] of best) if (r.is_holiday) out.set(d, { id: r.id, name: r.name, scope: r.scope });
  return out;
}

export async function resolveHolidays(
  db: DbOrTrx,
  hotelId: number,
  from: string,
  to: string,
): Promise<Map<string, string>> {
  const rows = await resolveHolidayRows(db, hotelId, from, to);
  return new Map([...rows].map(([d, h]) => [d, h.name]));
}
