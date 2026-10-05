import { addDays } from '@dienst/rules';
import type { Db } from '../db';
import { loadConfig } from '../config';
import { Keys } from '../lib/keys';
import { sha256 } from '../lib/security';
import { zonedInstant } from '../lib/time';
import { DEMO_API_KEY, DEMO_BADGE, DEMO_BERLIN_KIOSK_TOKEN } from './sample';
import type { SeedResult } from './index';

/** A one-page PDF so the demo document opens. */
const TINY_PDF = Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/**
 * Demo data for the backlog features (M10-M13). Most of it lives in the Berlin hotel so that the Frankfurt
 * flows used by the end-to-end suite stay as they are; the administrator sees both hotels.
 */
export async function seedBacklog(db: Db, r: SeedResult, now: Date) {
  const keys = new Keys(loadConfig());
  const today: string = r.today;
  const hotels: Record<string, number> = r.ids.hotels;
  const shifts: Record<string, number> = r.ids.shifts;
  const depts: Record<string, number> = r.ids.depts;
  const emp: Record<string, number> = r.ids.empIds;
  const adUser: number = r.ids.adUser;
  const mgUser: number = r.ids.mgUser;
  const company: number = r.ids.company;
  const ber = hotels.ber;
  const tz = 'Europe/Berlin';
  const d = (n: number) => addDays(today, n);
  const userOf = async (key: string) =>
    (
      await db
        .selectFrom('employee')
        .select('user_id')
        .where('employee_id', '=', emp[key])
        .executeTakeFirstOrThrow()
    ).user_id;

  // --- M13 platform: Berlin uses break start/stop, badge + PIN and allows the web punch from the hotel network
  await db
    .updateTable('hotel')
    .set({
      break_mode: 'start_stop',
      kiosk_identification: 'badge_pin',
      allow_web_punch: true,
      web_punch_allowed_cidrs: ['10.0.0.0/8', '192.168.0.0/16'],
    })
    .where('id', '=', ber)
    .execute();
  await db
    .insertInto('kiosk_device')
    .values({
      hotel_id: ber,
      name: 'Rezeptions-Tablet Berlin',
      token_hash: sha256(DEMO_BERLIN_KIOSK_TOKEN),
      registered_by_user_id: adUser,
    })
    .execute();
  await db
    .updateTable('employee')
    .set({ badge_hash: keys.badgeHashes(DEMO_BADGE)[0] })
    .where('employee_id', '=', emp.clara)
    .execute();
  await db
    .insertInto('api_key')
    .values({
      company_id: company,
      hotel_id: null,
      name: 'Demo Lohnbüro (nur lesen)',
      key_prefix: DEMO_API_KEY.slice(0, 10),
      key_hash: sha256(DEMO_API_KEY),
      created_by_user_id: adUser,
    })
    .execute();

  // occupancy forecast and staffing rules (suggestions only)
  for (const hk of ['ffm', 'ber']) {
    const pcts = [62, 70, 85, 92, 96, 88, 55, 48, 66, 78, 90, 95, 80, 60];
    await db
      .insertInto('occupancy_forecast')
      .values(pcts.map((p, i) => ({ hotel_id: hotels[hk], on_date: d(i), occupancy_pct: p })))
      .execute();
  }
  for (const [pct, n] of [
    [0, 1],
    [70, 2],
    [90, 3],
  ] as const)
    await db
      .insertInto('staffing_rule')
      .values({ hotel_id: ber, shift_id: shifts['ber:E'], min_occupancy_pct: pct, headcount: n })
      .execute();

  // --- M10 leave: blackout, leave and shift wishes
  await db
    .insertInto('absence_blackout')
    .values({
      hotel_id: ber,
      department_id: null,
      from_date: d(40),
      to_date: d(54),
      reason: 'Messe und Hochsaison',
      max_concurrent_absent: 1,
      created_by_user_id: adUser,
    })
    .execute();
  await db
    .insertInto('employee_leave_wish')
    .values([
      {
        employee_id: emp.clara,
        hotel_id: ber,
        start_date: d(45),
        end_date: d(49),
        leave_days: 5,
        priority: 1,
        reason: 'Hochzeit in der Familie',
      },
      {
        employee_id: emp.omer,
        hotel_id: ber,
        start_date: d(70),
        end_date: d(76),
        leave_days: 5,
        priority: 2,
        reason: 'Sommerurlaub',
      },
    ])
    .execute();
  await db
    .insertInto('employee_shift_wish')
    .values({
      employee_id: emp.hannah,
      hotel_id: ber,
      date: d(9),
      shift_id: shifts['ber:L'],
      priority: 2,
      reason: 'Arzttermin am Vormittag',
    })
    .execute();

  // --- M12 collaboration
  const qual = async (name: string, hasExpiry: boolean) =>
    (
      await db
        .insertInto('qualification')
        .values({ company_id: company, name, has_expiry: hasExpiry })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const hygiene = await qual('Hygieneschulung (IfSG)', true);
  const firstAid = await qual('Ersthelfer', true);
  await db
    .insertInto('employee_qualification')
    .values([
      { employee_id: emp.clara, qualification_id: hygiene, valid_until: d(25) },
      { employee_id: emp.omer, qualification_id: hygiene, valid_until: d(300) },
      { employee_id: emp.hannah, qualification_id: firstAid, valid_until: d(200) },
      { employee_id: emp.maria, qualification_id: hygiene, valid_until: d(180) },
    ])
    .execute();
  await db
    .insertInto('employee_availability')
    .values([
      {
        employee_id: emp.omer,
        weekday: 3,
        from_time: '06:00',
        to_time: '14:00',
        kind: 'unavailable',
        valid_from: today,
        note: 'Sprachkurs',
      },
      {
        employee_id: emp.hannah,
        weekday: 6,
        from_time: '14:00',
        to_time: '22:00',
        kind: 'preferred',
        valid_from: today,
        note: null,
      },
    ])
    .execute();
  await db
    .insertInto('employee_document')
    .values({
      employee_id: emp.clara,
      doc_type: 'hygiene_instruction',
      title: 'Belehrung nach Infektionsschutzgesetz',
      file_name: 'belehrung.pdf',
      mime: 'application/pdf',
      size_bytes: TINY_PDF.length,
      content_enc: keys.seal('documents', TINY_PDF),
      valid_until: d(25),
      visible_to_employee: true,
      uploaded_by_user_id: adUser,
    })
    .execute();

  // open shift in Berlin, one application
  const os = await db
    .insertInto('open_shift')
    .values({
      hotel_id: ber,
      department_id: depts['ber:fd'],
      shift_id: shifts['ber:L'],
      shift_date: d(10),
      planned_start: zonedInstant(d(10), '14:00', tz),
      planned_end: zonedInstant(d(10), '22:00', tz),
      planned_break_minutes: 30,
      created_by_user_id: adUser,
      created_by_role: 'admin',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db.insertInto('open_shift_claim').values({ open_shift_id: os.id, employee_id: emp.hannah }).execute();

  // swap offer: Clara offers an early shift next week (needs a published entry, so we create one)
  const early = await db
    .insertInto('schedule')
    .values({
      hotel_id: ber,
      employee_id: emp.clara,
      shift_id: shifts['ber:E'],
      shift_date: d(20),
      planned_start: zonedInstant(d(20), '06:00', tz),
      planned_end: zonedInstant(d(20), '14:00', tz),
      planned_break_minutes: 30,
      status: 'published',
      created_by_user_id: adUser,
      created_by_role: 'admin',
    })
    .returning('id')
    .executeTakeFirst();
  if (early)
    await db
      .insertInto('shift_swap_request')
      .values({
        hotel_id: ber,
        schedule_id: early.id,
        requester_employee_id: emp.clara,
        counterpart_employee_id: null,
        reason: 'Familientermin',
        expires_at: new Date(now.getTime() + 36 * 3600e3),
      })
      .execute();

  // announcements, board, question
  const ann = await db
    .insertInto('announcement')
    .values([
      {
        company_id: company,
        hotel_id: ber,
        title: 'Neue Pausenregelung am Tablet',
        body: 'Ab sofort startest und beendest du deine Pause direkt am Tablet. Bitte zeige den Badge am Leser.',
        pinned: true,
        requires_ack: true,
        created_by_user_id: adUser,
      },
      {
        company_id: company,
        hotel_id: ber,
        title: 'Sommerfest',
        body: 'Das Sommerfest findet am letzten Freitag im Monat statt.',
        pinned: false,
        requires_ack: false,
        created_by_user_id: adUser,
      },
    ])
    .returning('id')
    .execute();
  await db
    .insertInto('announcement_ack')
    .values({ announcement_id: ann[0].id, employee_id: emp.clara })
    .execute();
  const post = await db
    .insertInto('feed_post')
    .values({
      hotel_id: ber,
      author_user_id: await userOf('clara'),
      author_name: 'Clara N.',
      body: 'Danke an die Frühschicht für die Übergabe heute!',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('feed_comment')
    .values({
      post_id: post.id,
      author_user_id: await userOf('omer'),
      author_name: 'Ömer K.',
      body: 'Gern geschehen.',
    })
    .execute();
  await db
    .insertInto('feed_like')
    .values({ post_id: post.id, user_id: await userOf('hannah') })
    .execute();
  await db
    .insertInto('management_question')
    .values({
      employee_id: emp.omer,
      hotel_id: ber,
      subject: 'Dienstkleidung',
      body: 'Wann bekomme ich meine neue Dienstkleidung?',
    })
    .execute();
  void mgUser;
}
