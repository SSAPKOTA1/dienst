import { sql } from 'kysely';
import { authenticator } from 'otplib';
import { addDays, mondayOf } from '@dienst/rules';
import type { Db } from '../db';
import { buildPrincipal } from '../lib/scope';
import { encryptSecret, hashSecret, sha256 } from '../lib/security';
import { loadConfig } from '../config';
import { audit } from '../lib/audit';
import { createEmployee } from '../services/employees';
import { holidaysFor } from './holidays';
import { seedSchedule } from './schedule';
import {
  DEMO_KIOSK_TOKEN,
  DEMO_PASSWORD,
  DEMO_PINS,
  DEMO_TOTP_SECRET,
  isoBirth,
  loadSample,
  num,
} from './sample';

export interface SeedResult {
  today: string;
  logins: Array<{ login: string; role: string; note: string }>;
  employees: Array<{
    name: string;
    username: string | null;
    email: string | null;
    pin: string;
    personnelNumber: string;
    activationCode?: string;
    hotel: string;
  }>;
  kioskToken: string;
  totpSecret: string;
  ids: Record<string, any>;
}

export async function resetAll(db: Db) {
  const rows = await sql<{
    tablename: string;
  }>`select tablename from pg_tables where schemaname='public' and tablename not in ('schema_migrations','absence_type')`.execute(
    db,
  );
  // audit_log is append-only (trigger); TRUNCATE is allowed because the trigger is row-level
  await sql
    .raw(`TRUNCATE ${rows.rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`)
    .execute(db);
}

export async function runSeed(db: Db, now: Date): Promise<SeedResult> {
  const cfg = loadConfig();
  const sample = loadSample();
  const today = now.toISOString().slice(0, 10);
  const week0 = mondayOf(today);
  const pw = await hashSecret(DEMO_PASSWORD);
  const totp = encryptSecret(DEMO_TOTP_SECRET, cfg.TOTP_ENC_KEY);
  void authenticator;

  const user = (email: string | null, username: string | null, withTotp = false) =>
    db
      .insertInto('user_account')
      .values({
        email,
        username,
        password_hash: pw,
        status: 'active',
        ...(withTotp ? { totp_enabled: true, totp_secret_enc: totp } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
      .then((r) => r.id);

  // --- staff accounts
  const saUser = await user('sa@demo.test', null, true);
  const sa = await db
    .insertInto('super_admin')
    .values({ user_id: saUser, first_name: 'Sam', last_name: 'Superadmin' })
    .returning('super_admin_id')
    .executeTakeFirstOrThrow();
  const company = await db
    .insertInto('company')
    .values({ name: 'Trip Inn Hotels', created_by_id: sa.super_admin_id })
    .returning('id')
    .executeTakeFirstOrThrow();
  const adUser = await user('admin@demo.test', null, true);
  const ad = await db
    .insertInto('admin')
    .values({ user_id: adUser, first_name: 'Anna', last_name: 'Krüger', created_by_id: sa.super_admin_id })
    .returning('admin_id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('admin_company')
    .values({ admin_id: ad.admin_id, company_id: company.id, assigned_by_id: sa.super_admin_id })
    .execute();

  const hotelRows: Record<string, number> = {};
  const states: Record<string, string> = { ffm: 'HE', ber: 'BE' };
  for (const [key, name] of Object.entries(sample.HOTELS)) {
    const h = await db
      .insertInto('hotel')
      .values({ company_id: company.id, name, city: name, federal_state: states[key] })
      .returning('id')
      .executeTakeFirstOrThrow();
    hotelRows[key] = h.id;
  }
  const deptRows: Record<string, number> = {}; // `${hotel}:${dept}`
  for (const hk of Object.keys(hotelRows)) {
    for (const d of sample.DEPTS) {
      const r = await db
        .insertInto('department')
        .values({ hotel_id: hotelRows[hk], name: d.name })
        .returning('id')
        .executeTakeFirstOrThrow();
      deptRows[`${hk}:${d.id}`] = r.id;
    }
  }
  // --- shift templates and required headcount (sums per department equal the prototype minimums)
  const shiftRows: Record<string, number> = {};
  const MIN: Record<string, Record<string, Record<string, [number, number]>>> = {
    // [weekday (Mo-Fr), weekend]
    ffm: { fd: { E: [1, 1], L: [1, 0], N: [1, 0] }, hk: { D: [3, 1] }, bf: { B: [1, 1] } },
    ber: { fd: { E: [1, 1], L: [1, 0] }, hk: { D: [2, 1] }, bf: { B: [1, 1] } },
  };
  for (const hk of Object.keys(hotelRows)) {
    for (const [dept, codes] of Object.entries(MIN[hk])) {
      for (const [code, [wk, we]] of Object.entries(codes)) {
        const t = sample.SH[code];
        const [start, end] = t.t.split('–');
        const gross =
          (Number(end.slice(0, 2)) * 60 +
            Number(end.slice(3)) -
            (Number(start.slice(0, 2)) * 60 + Number(start.slice(3))) +
            1440) %
          1440;
        const brk = gross > 390 ? 30 : 0; // SPEC 7: 30 min where the shift is longer than 6 h 30
        const sh = await db
          .insertInto('shift')
          .values({
            hotel_id: hotelRows[hk],
            department_id: deptRows[`${hk}:${dept}`],
            name: t.n,
            start_time: start,
            end_time: end,
            break_duration_minutes: brk,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        shiftRows[`${hk}:${code}`] = sh.id;
        for (let wd = 1; wd <= 7; wd++) {
          const n = wd <= 5 ? wk : we;
          if (n > 0)
            await db
              .insertInto('shift_staffing_requirement')
              .values({ shift_id: sh.id, weekday: wd, required_headcount: n })
              .execute();
        }
      }
    }
  }
  const mgUser = await user('manager@demo.test', null);
  const mg = await db
    .insertInto('manager')
    .values({ user_id: mgUser, first_name: 'Markus', last_name: 'Lehmann', created_by_id: ad.admin_id })
    .returning('manager_id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('manager_hotel')
    .values({ manager_id: mg.manager_id, hotel_id: hotelRows.ffm })
    .execute();

  // --- kiosk device (Frankfurt reception)
  await db
    .insertInto('kiosk_device')
    .values({
      hotel_id: hotelRows.ffm,
      name: 'Rezeptions-Tablet',
      token_hash: sha256(DEMO_KIOSK_TOKEN),
      registered_by_user_id: adUser,
    })
    .execute();

  // --- holidays 2026-2027
  for (const y of [2026, 2027]) {
    for (const h of holidaysFor(y)) {
      await db
        .insertInto('public_holiday')
        .values({ scope: h.scope, federal_state: h.state ?? null, date: h.date, name: h.name })
        .execute();
    }
  }

  // --- employees through the real onboarding service
  const adminPrincipal = (await buildPrincipal(db, adUser, 'admin'))!;
  const result: SeedResult = {
    today,
    logins: [],
    employees: [],
    kioskToken: DEMO_KIOSK_TOKEN,
    totpSecret: DEMO_TOTP_SECRET,
    ids: {
      company: company.id,
      hotels: hotelRows,
      depts: deptRows,
      shifts: shiftRows,
      saUser,
      adUser,
      mgUser,
      adminId: ad.admin_id,
      managerId: mg.manager_id,
      week0,
      empIds: {} as Record<string, number>,
    },
  };
  result.logins.push(
    { login: 'sa@demo.test', role: 'Super admin', note: 'TOTP required' },
    { login: 'admin@demo.test', role: 'Admin (Anna Krüger)', note: 'TOTP required' },
    { login: 'manager@demo.test', role: 'Manager Frankfurt', note: '' },
  );
  let i = 0;
  for (const e of sample.EMPS) {
    const hk = e.h ?? 'ffm';
    const [first, ...rest] = e.name.split(' ');
    const last = rest.join(' ');
    const working = [...e.w].map((c, idx) => (c !== 'F' && c !== '.' ? idx + 1 : 0)).filter(Boolean);
    const hourly = e.meta === 'Minijob';
    const remaining = num(e.vac);
    const carry = num(e.carry);
    const noEmail = e.id === 'sven';
    const email = noEmail
      ? null
      : `${first.toLowerCase().replace(/ö/g, 'oe')}.${last.toLowerCase().replace(/[^a-z]/g, '')}@demo.test`;
    const extraHotels = e.floating ? [hotelRows.ber] : [];
    const created = await db.transaction().execute((trx) =>
      createEmployee(
        trx,
        adminPrincipal,
        {
          firstName: first,
          lastName: last,
          dateOfBirth: isoBirth(e.birth),
          email,
          primaryHotelId: hotelRows[hk],
          primaryDepartmentId: deptRows[`${hk}:${e.d}`],
          hotelIds: extraHotels,
          departmentIds: e.floating ? [deptRows[`ber:${e.d}`]] : [],
          contractStartDate: today,
          employmentType: e.meta.startsWith('Azubi')
            ? 'apprentice'
            : e.meta === 'Minijob'
              ? 'minijob'
              : e.meta === 'Teilzeit'
                ? 'part_time'
                : 'full_time',
          workingModel: hourly ? 'hourly' : 'salary',
          workDaysPerWeek: working.length,
          workingWeekdays: working,
          targetHoursPerWeek: e.t,
          vacationDaysPerYear: 30,
          vacationDaysAllocatedThisYear: remaining + 0, // adjusted below once approved absences are known
          vacationDaysUsedThisYear: 0,
          openingBalanceHours: hourly ? 0 : num(e.acct),
          isFloater: !!e.floating,
          monthlyHoursCap: e.meta === 'Minijob' ? 43 : undefined,
        },
        now,
        { pin: DEMO_PINS[i] },
      ),
    );
    await db
      .updateTable('employee')
      .set({ personnel_number: e.num })
      .where('employee_id', '=', created.employeeId)
      .execute();
    await db
      .updateTable('employee_vacation_allowance')
      .set({ carried_contractual_days: carry })
      .where('employee_id', '=', created.employeeId)
      .execute();
    await audit(
      db,
      { userId: adUser, type: 'admin' },
      {
        action: 'employee_created',
        entityType: 'employee',
        entityId: created.employeeId,
        companyId: company.id,
        hotelId: hotelRows[hk],
        new: { personnelNumber: e.num },
      },
    );
    if (!noEmail) {
      await db
        .updateTable('user_account')
        .set({
          password_hash: pw,
          status: 'active',
          last_login_at: new Date(now.getTime() - (1 + (i % 5)) * 86400e3),
          invitation_token_hash: null,
          invitation_expires_at: null,
        })
        .where('id', '=', created.userId)
        .execute();
    }
    result.ids.empIds[e.id] = created.employeeId;
    result.employees.push({
      name: e.name,
      username: created.username,
      email,
      pin: created.pin,
      personnelNumber: e.num,
      activationCode: created.activation.code,
      hotel: sample.HOTELS[hk],
    });
    i++;
  }
  void addDays;
  await seedSchedule(db, result, now);
  return result;
}
