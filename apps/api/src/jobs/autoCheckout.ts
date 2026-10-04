import type { Db } from '../db';
import { audit, SYSTEM_ACTOR } from '../lib/audit';
import { computeClose, graceOf, hotelManagerUsers, paidFor } from '../services/kiosk';

/**
 * SPEC 4.5 step 8. Open record with a schedule entry and now > planned_end + 60 min -> checked out at planned_end,
 * break = required break; unplanned records open for more than 12 h -> in + 8 h. Always pending approval.
 */
export async function runAutoCheckout(db: Db, now: Date): Promise<number> {
  const open = await db
    .selectFrom('punch_record')
    .selectAll()
    .where('actual_punch_out', 'is', null)
    .execute();
  let n = 0;
  for (const r of open) {
    let out: Date | null = null;
    if (r.schedule_id && r.planned_end && now.getTime() > r.planned_end.getTime() + 60 * 60e3)
      out = r.planned_end;
    else if (!r.schedule_id && now.getTime() - r.actual_punch_in.getTime() > 12 * 3600e3)
      out = new Date(r.actual_punch_in.getTime() + 8 * 3600e3);
    if (!out || out <= r.actual_punch_in) continue;
    await db.transaction().execute(async (trx) => {
      const emp = await trx
        .selectFrom('employee')
        .select(['employee_id', 'user_id', 'company_id', 'display_name'])
        .where('employee_id', '=', r.employee_id)
        .executeTakeFirstOrThrow();
      const grace = await graceOf(trx, emp.company_id);
      const c = computeClose(
        {
          paid_start: r.paid_start,
          actual_punch_in: r.actual_punch_in,
          planned_end: r.planned_end,
          is_unplanned: r.is_unplanned,
        },
        out!,
        grace,
      );
      const brk = c.requiredBreak;
      const upd = await trx
        .updateTable('punch_record')
        .set({
          actual_punch_out: out!,
          paid_start: c.paidStart,
          paid_end: c.paidEnd,
          required_break_minutes: brk,
          actual_break_minutes: brk,
          paid_hours: paidFor(c.paidStart, c.paidEnd, brk),
          end_variation_minutes: c.endVariation,
          auto_checked_out: true,
          approval_status: 'pending',
          approval_source: null,
          updated_at: now,
        })
        .where('id', '=', r.id)
        .where('actual_punch_out', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!upd) return;
      await trx
        .insertInto('punch_record_history')
        .values({
          punch_record_id: r.id,
          changed_by_role: 'system',
          change_type: 'auto_checkout',
          old_values: JSON.stringify({ actual_punch_out: null }),
          new_values: JSON.stringify({ actual_punch_out: out!.toISOString(), actual_break_minutes: brk }),
        })
        .execute();
      const users = [emp.user_id, ...(await hotelManagerUsers(trx, r.hotel_id))];
      for (const uid of new Set(users)) {
        await trx
          .insertInto('notification')
          .values({
            user_id: uid,
            employee_id: uid === emp.user_id ? emp.employee_id : null,
            kind: 'auto_checkout',
            payload: JSON.stringify({
              punchRecordId: r.id,
              employeeId: emp.employee_id,
              hotelId: r.hotel_id,
            }),
          })
          .execute();
      }
      await audit(trx, SYSTEM_ACTOR, {
        action: 'auto_checkout',
        entityType: 'punch_record',
        entityId: r.id,
        hotelId: r.hotel_id,
        companyId: emp.company_id,
        new: { out: out!.toISOString() },
      });
      n++;
    });
  }
  return n;
}

/** Plaintext credentials of an import (encrypted at rest) are wiped once the 24 h window has passed. */
export async function wipeExpiredCredentials(db: Db, now: Date): Promise<number> {
  const r = await db
    .updateTable('import_job')
    .set({ credentials_enc: null })
    .where('credentials_enc', 'is not', null)
    .where('credentials_expires_at', '<=', now)
    .executeTakeFirst();
  return Number(r.numUpdatedRows);
}
