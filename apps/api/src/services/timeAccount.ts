import { countedDays, timeAccountBalance, addDays } from '@dienst/rules';
import type { DbOrTrx } from '../db';
import { resolveHolidays } from './holidays';

export interface LedgerLine {
  /** YYYY-MM, or the entry date for manual lines */
  month: string;
  type: 'opening_balance' | 'worked' | 'absence_credit' | 'target' | 'correction' | 'payout';
  hours: number;
  note?: string | null;
  entryId?: number;
}
export interface Ledger {
  balanceHours: number;
  asOf: string;
  lines: LedgerLine[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const monthsBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  while (`${y}-${String(m).padStart(2, '0')}` <= to.slice(0, 7)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
};

/**
 * SPEC 4.15 and the backlog ledger. The lines opening balance, worked (approved hours), absence credit and target are derived
 * from approved data; correction and payout lines are the stored manual entries. Their sum is the balance.
 * Returns null when the employee has no time account (hourly or no target).
 */
export async function buildLedger(db: DbOrTrx, employeeId: number, today: string): Promise<Ledger | null> {
  const emp = await db
    .selectFrom('employee')
    .select(['contract_start_date', 'opening_balance_hours', 'primary_hotel_id'])
    .where('employee_id', '=', employeeId)
    .executeTakeFirst();
  if (!emp) return null;
  const c = await db
    .selectFrom('employee_contract')
    .selectAll()
    .where('employee_id', '=', employeeId)
    .where('valid_from', '<=', today)
    .orderBy('valid_from', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!c || c.working_model !== 'salary') return null;
  const weekly =
    c.target_hours_per_week ??
    (c.target_hours_per_month != null ? (c.target_hours_per_month * 12) / 52 : null);
  if (weekly == null && c.target_hours_per_month == null) return null;
  const monthly = c.target_hours_per_month ?? ((weekly as number) * 52) / 12;
  const daily = c.daily_target_hours ?? (weekly != null ? weekly / c.work_days_per_week : 0);
  const start = emp.contract_start_date;
  const last = addDays(today, -1); // today is exclusive
  const manual = await db
    .selectFrom('arbeitszeitkonto_entry')
    .selectAll()
    .where('employee_id', '=', employeeId)
    .where('entry_date', '<=', last)
    .orderBy('entry_date')
    .orderBy('id')
    .execute();
  const manualLines: LedgerLine[] = manual.map((m) => ({
    month: m.entry_date,
    type: m.entry_type as 'correction' | 'payout',
    hours: m.hours,
    note: m.note,
    entryId: m.id,
  }));
  const manualSum = manual.reduce((a, m) => a + m.hours, 0);
  const opening: LedgerLine = {
    month: start.slice(0, 7),
    type: 'opening_balance',
    hours: emp.opening_balance_hours,
  };
  if (last < start)
    return {
      asOf: today,
      balanceHours: r2(emp.opening_balance_hours + manualSum),
      lines: [opening, ...manualLines],
    };

  const punches = await db
    .selectFrom('punch_record')
    .select(['shift_date', 'paid_hours'])
    .where('employee_id', '=', employeeId)
    .where('approval_status', '=', 'approved')
    .where('shift_date', '>=', start)
    .where('shift_date', '<=', last)
    .execute();
  const approved = punches.reduce((a, p) => a + (p.paid_hours ?? 0), 0);

  const holidays = new Set((await resolveHolidays(db, emp.primary_hotel_id, start, last)).keys());
  const absences = await db
    .selectFrom('time_off as t')
    .innerJoin('absence_type as a', 'a.code', 't.type')
    .select(['t.start_date', 't.end_date', 'a.credits_hours', 'a.reduces_target'])
    .where('t.employee_id', '=', employeeId)
    .where('t.status', '=', 'approved')
    .where('t.end_date', '>=', start)
    .where('t.start_date', '<=', last)
    .execute();
  const creditDays: string[] = [];
  const unpaidDays: string[] = [];
  const absentDays = new Set<string>();
  for (const a of absences) {
    const from = a.start_date < start ? start : a.start_date;
    const to = a.end_date > last ? last : a.end_date;
    const days = countedDays(from, to, c.working_weekdays, holidays);
    days.forEach((d) => absentDays.add(d));
    if (a.credits_hours) creditDays.push(...days);
    if (a.reduces_target) unpaidDays.push(...days);
  }
  // public holidays on working weekdays without an absence or a punch are credited (salary workers)
  const punchDays = new Set(
    (
      await db
        .selectFrom('punch_record')
        .select('shift_date')
        .where('employee_id', '=', employeeId)
        .where('shift_date', '>=', start)
        .where('shift_date', '<=', last)
        .execute()
    ).map((r) => r.shift_date),
  );
  for (const h of holidays) {
    if (h >= start && h <= last && !absentDays.has(h) && !punchDays.has(h)) {
      if (countedDays(h, h, c.working_weekdays, new Set()).length) creditDays.push(h);
    }
  }
  const balance = timeAccountBalance({
    opening: emp.opening_balance_hours,
    monthlyTarget: monthly,
    startIso: start,
    asOfIso: today,
    approvedPaidHours: approved,
    creditHours: creditDays.length * daily,
    unpaidDays: unpaidDays.length,
    dailyTarget: daily,
  });
  const lines: LedgerLine[] = [opening];
  const months = monthsBetween(start, last);
  const targets: number[] = [];
  for (const m of months) {
    const dim = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
    const a = start > `${m}-01` ? start : `${m}-01`;
    const b = last < `${m}-${dim}` ? last : `${m}-${String(dim).padStart(2, '0')}`;
    const days = Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
    targets.push((monthly * days) / dim - daily * unpaidDays.filter((d) => d.startsWith(m)).length);
  }
  months.forEach((m, i) => {
    const worked = punches
      .filter((p) => p.shift_date.startsWith(m))
      .reduce((a, p) => a + (p.paid_hours ?? 0), 0);
    const credit = creditDays.filter((d) => d.startsWith(m)).length * daily;
    if (worked) lines.push({ month: m, type: 'worked', hours: r2(worked) });
    if (credit) lines.push({ month: m, type: 'absence_credit', hours: r2(credit) });
    lines.push({ month: m, type: 'target', hours: -r2(targets[i]!) });
  });
  return { asOf: today, balanceHours: r2(balance + manualSum), lines: [...lines, ...manualLines] };
}

/** SPEC 4.15. Returns null when the employee has no time account (hourly or no target). */
export async function computeTimeAccount(
  db: DbOrTrx,
  employeeId: number,
  today: string,
): Promise<number | null> {
  return (await buildLedger(db, employeeId, today))?.balanceHours ?? null;
}
