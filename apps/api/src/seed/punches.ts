import { addDays, requiredBreakMinutes } from '@dienst/rules';
import type { Db } from '../db';
import { localDate, zonedInstant } from '../lib/time';
import { paidFor } from '../services/kiosk';
import type { SeedResult } from './index';

/** Live view content (today's punches), one unplanned open record and the prototype's two correction requests. */
export async function seedPunches(db: Db, r: SeedResult, now: Date) {
  const hotels: Record<string, number> = r.ids.hotels;
  const empIds: Record<string, number> = r.ids.empIds;
  const adUser: number = r.ids.adUser;
  const device = await db.selectFrom('kiosk_device').select('id').executeTakeFirstOrThrow();
  const hotelRows = await db.selectFrom('hotel').select(['id', 'timezone']).execute();
  const tz = new Map(hotelRows.map((h) => [h.id, h.timezone]));
  const min = (n: number) => n * 60e3;

  // ---- today's published entries
  let firstOpen = true;
  for (const [, hotelId] of Object.entries(hotels)) {
    const today = localDate(now, tz.get(hotelId)!);
    const entries = await db
      .selectFrom('schedule')
      .selectAll()
      .where('hotel_id', '=', hotelId)
      .where('shift_date', '=', today)
      .where('status', '=', 'published')
      .orderBy('planned_start')
      .execute();
    for (const e of entries) {
      const started = e.planned_start.getTime() <= now.getTime();
      const over = now.getTime() > e.planned_end.getTime() + min(60);
      if (!started) continue;
      const inAt = new Date(e.planned_start.getTime() + min(2));
      if (over) {
        const gross = Math.floor((e.planned_end.getTime() - e.planned_start.getTime()) / 60000);
        const brk = requiredBreakMinutes(gross);
        await db
          .insertInto('punch_record')
          .values({
            employee_id: e.employee_id,
            hotel_id: hotelId,
            schedule_id: e.id,
            shift_date: today,
            source: 'kiosk',
            kiosk_device_id: device.id,
            planned_start: e.planned_start,
            planned_end: e.planned_end,
            actual_punch_in: inAt,
            actual_punch_out: e.planned_end,
            paid_start: e.planned_start,
            paid_end: e.planned_end,
            start_variation_minutes: 2,
            end_variation_minutes: 0,
            required_break_minutes: brk,
            actual_break_minutes: brk,
            paid_hours: paidFor(e.planned_start, e.planned_end, brk),
            approval_status: 'approved',
            approval_source: 'auto',
            approved_at: e.planned_end,
          })
          .execute();
      } else if (firstOpen) {
        firstOpen = false; // clocked in and still working
        await db
          .insertInto('punch_record')
          .values({
            employee_id: e.employee_id,
            hotel_id: hotelId,
            schedule_id: e.id,
            shift_date: today,
            source: 'kiosk',
            kiosk_device_id: device.id,
            planned_start: e.planned_start,
            planned_end: e.planned_end,
            actual_punch_in: inAt,
            paid_start: e.planned_start,
            start_variation_minutes: 2,
            approval_status: 'pending',
          })
          .execute();
      }
      // every other started entry stays without a punch: it shows up as expected / no-show
    }
  }
  // ---- an unplanned open record (Piotr helps out)
  const piotrIn = new Date(now.getTime() - 3 * 3600e3);
  const piotrRec = await db
    .insertInto('punch_record')
    .values({
      employee_id: empIds.piotr,
      hotel_id: hotels.ffm,
      schedule_id: null,
      is_unplanned: true,
      shift_date: localDate(piotrIn, tz.get(hotels.ffm)!),
      source: 'kiosk',
      kiosk_device_id: device.id,
      actual_punch_in: piotrIn,
      paid_start: piotrIn,
      approval_status: 'pending',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('time_variation')
    .values({
      punch_record_id: piotrRec.id,
      employee_id: empIds.piotr,
      hotel_id: hotels.ffm,
      variation_type: 'unplanned',
      actual_time: piotrIn,
    })
    .execute();

  // ---- Sven: forgot to clock out on Wednesday of the seed week (auto checkout) + correction request
  const week0: string = r.ids.week0;
  const wed = addDays(week0, 2);
  const svenEntry = await db
    .selectFrom('schedule')
    .selectAll()
    .where('employee_id', '=', empIds.sven)
    .where('shift_date', '=', wed)
    .executeTakeFirst();
  if (svenEntry) {
    const inAt = new Date(svenEntry.planned_start.getTime() + min(2));
    const rec = await db
      .insertInto('punch_record')
      .values({
        employee_id: empIds.sven,
        hotel_id: hotels.ffm,
        schedule_id: svenEntry.id,
        shift_date: wed,
        source: 'kiosk',
        kiosk_device_id: device.id,
        planned_start: svenEntry.planned_start,
        planned_end: svenEntry.planned_end,
        actual_punch_in: inAt,
        actual_punch_out: svenEntry.planned_end,
        paid_start: svenEntry.planned_start,
        paid_end: svenEntry.planned_end,
        start_variation_minutes: 2,
        end_variation_minutes: 0,
        required_break_minutes: 30,
        actual_break_minutes: 30,
        paid_hours: 8,
        auto_checked_out: true,
        approval_status: 'pending',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const reqOut = zonedInstant(wed, '16:20', tz.get(hotels.ffm)!);
    const svenUser = (
      await db
        .selectFrom('employee')
        .select('user_id')
        .where('employee_id', '=', empIds.sven)
        .executeTakeFirstOrThrow()
    ).user_id;
    void svenUser;
    await db
      .insertInto('time_correction_request')
      .values({
        employee_id: empIds.sven,
        hotel_id: hotels.ffm,
        punch_record_id: rec.id,
        correction_type: 'missed_out',
        requested_out: reqOut,
        requested_break_minutes: 30,
        reason: 'Ich habe vergessen auszustempeln.',
      })
      .execute();
  }
  // ---- Maria: clocked in late on Tuesday, wants 05:58 -> wrong_time correction
  const tue = addDays(week0, 1);
  const mEntry = await db
    .selectFrom('schedule')
    .selectAll()
    .where('employee_id', '=', empIds.maria)
    .where('shift_date', '=', tue)
    .executeTakeFirst();
  if (mEntry) {
    const inAt = new Date(mEntry.planned_start.getTime() + min(21));
    const rec = await db
      .insertInto('punch_record')
      .values({
        employee_id: empIds.maria,
        hotel_id: hotels.ffm,
        schedule_id: mEntry.id,
        shift_date: tue,
        source: 'kiosk',
        kiosk_device_id: device.id,
        planned_start: mEntry.planned_start,
        planned_end: mEntry.planned_end,
        actual_punch_in: inAt,
        actual_punch_out: mEntry.planned_end,
        paid_start: inAt,
        paid_end: mEntry.planned_end,
        start_variation_minutes: 21,
        end_variation_minutes: 0,
        required_break_minutes: 30,
        actual_break_minutes: 30,
        paid_hours: paidFor(inAt, mEntry.planned_end, 30),
        approval_status: 'pending',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('time_variation')
      .values({
        punch_record_id: rec.id,
        employee_id: empIds.maria,
        hotel_id: hotels.ffm,
        variation_type: 'clock_in_late',
        planned_time: mEntry.planned_start,
        actual_time: inAt,
        variation_minutes: 21,
        reason: 'Tablet war eingefroren',
      })
      .execute();
    await db
      .insertInto('time_correction_request')
      .values({
        employee_id: empIds.maria,
        hotel_id: hotels.ffm,
        punch_record_id: rec.id,
        correction_type: 'wrong_time',
        requested_in: new Date(mEntry.planned_start.getTime() - min(2)),
        reason: 'Tablet war eingefroren',
      })
      .execute();
  }
  void adUser;
}
