import type { Selectable } from 'kysely';
import type { HotelEventDto, HotelEventKind } from '@dienst/shared';
import type { DB, Db } from '../db';

export const eventOut = (e: Selectable<DB['hotel_event']>): HotelEventDto => ({
  id: e.id,
  hotelId: e.hotel_id,
  title: e.title,
  kind: e.kind as HotelEventKind,
  startDate: e.start_date,
  endDate: e.end_date,
  note: e.note,
});

/** Entries of the given hotels that touch the range from..to. Callers pass hotel ids already cut to the scope. */
export async function eventsInRange(
  db: Db,
  hotelIds: number[],
  from: string,
  to: string,
): Promise<HotelEventDto[]> {
  if (!hotelIds.length) return [];
  const rows = await db
    .selectFrom('hotel_event')
    .selectAll()
    .where('hotel_id', 'in', hotelIds)
    .where('start_date', '<=', to)
    .where('end_date', '>=', from)
    .orderBy('start_date')
    .orderBy('id')
    .execute();
  return rows.map(eventOut);
}
