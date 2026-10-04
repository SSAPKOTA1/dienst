import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { icsCalendar, fold } from '../src/services/ics';
import {
  call,
  ctxHolder,
  employeeTokens,
  planFixture,
  startApp,
  stopApp,
  type PlanFx,
  type TestCtx,
} from './helpers';

let ctx: TestCtx;
let fx: PlanFx;
let emp: Record<string, string>;
const get = (url: string, token: string | null = null) =>
  ctx.app.inject({
    method: 'GET',
    url: `/api/v1${url}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-20T10:00:00Z') });
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
  emp = await employeeTokens(ctx, fx, ['maria', 'jon', 'tom', 'piotr']);
});
afterAll(async () => stopApp(ctx));

describe('announcements', () => {
  it('reach the right employees, can require confirmation and show who has not confirmed', async () => {
    expect((await call(ctx, 'POST', '/announcements', emp.maria!, { title: 'x', body: 'y' })).status).toBe(
      403,
    );
    // managers announce for their hotels only, the company-wide ones are for the administration
    expect(
      (await call(ctx, 'POST', '/announcements', fx.mgrA1.token, { title: 'Alle', body: 'x' })).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'POST', '/announcements', fx.mgrA1.token, {
          title: 'Berlin',
          body: 'x',
          hotelId: fx.hotelA2,
        })
      ).status,
    ).toBe(403);
    const h = await call(ctx, 'POST', '/announcements', fx.mgrA1.token, {
      title: 'Brandschutzübung',
      body: 'Freitag 10 Uhr, Treffpunkt Lobby.',
      hotelId: fx.hotelA1,
      requiresAck: true,
      pinned: true,
    });
    expect(h.status).toBe(201);
    const all = await call(ctx, 'POST', '/announcements', fx.adminA.token, {
      title: 'Betriebsversammlung',
      body: 'Im November',
    });
    expect(all.status).toBe(201);
    const fut = await call(ctx, 'POST', '/announcements', fx.adminA.token, {
      title: 'Später',
      body: 'x',
      publishAt: '2026-12-01T08:00:00+01:00',
    });
    expect(fut.status).toBe(201);
    const mine = await call(ctx, 'GET', '/me/announcements', emp.maria!);
    expect(mine.body.items.map((a: any) => a.title)).toEqual(['Brandschutzübung', 'Betriebsversammlung']); // pinned first, future one hidden
    expect(mine.body.items[0]).toMatchObject({ requiresAck: true, acknowledged: false });
    expect(
      (await ctx.db.selectFrom('notification').select('kind').where('kind', '=', 'announcement').execute())
        .length,
    ).toBeGreaterThanOrEqual(8);
    expect((await call(ctx, 'PUT', `/me/announcements/${h.body.id}/ack`, emp.maria!)).status).toBe(200);
    expect((await call(ctx, 'PUT', `/me/announcements/${h.body.id}/ack`, emp.maria!)).status).toBe(200); // idempotent
    expect((await call(ctx, 'PUT', `/me/announcements/${fut.body.id}/ack`, emp.maria!)).status).toBe(404);
    const board = await call(ctx, 'GET', `/announcements?hotelIds=${fx.hotelA1}`, fx.mgrA1.token);
    const row = board.body.items.find((a: any) => a.title === 'Brandschutzübung');
    expect(row.acknowledged).toBe(1);
    expect(row.missing).toContain('Jon T.');
    expect(row.missing).not.toContain('Maria T.');
    expect((await call(ctx, 'GET', '/announcements', fx.adminB.token)).body.items).toEqual([]);
    expect((await call(ctx, 'DELETE', `/announcements/${h.body.id}`, fx.mgrA2.token)).status).toBe(403);
    expect((await call(ctx, 'DELETE', `/announcements/${all.body.id}`, fx.mgrA1.token)).status).toBe(403);
    expect((await call(ctx, 'DELETE', `/announcements/${h.body.id}`, fx.mgrA1.token)).status).toBe(204);
    // a Berlin-only employee does not see Frankfurt announcements
    const b = await call(ctx, 'POST', '/announcements', fx.adminA.token, {
      title: 'Nur Frankfurt',
      body: 'x',
      hotelId: fx.hotelA1,
    });
    expect(b.status).toBe(201);
    await ctx.db
      .deleteFrom('employee_hotel')
      .where('employee_id', '=', fx.emp.tom!)
      .where('hotel_id', '=', fx.hotelA1)
      .execute();
    expect(
      (await call(ctx, 'GET', '/me/announcements', emp.tom!)).body.items.map((a: any) => a.title),
    ).not.toContain('Nur Frankfurt');
    await ctx.db
      .insertInto('employee_hotel')
      .values({ employee_id: fx.emp.tom!, hotel_id: fx.hotelA1 })
      .execute();
  });
});

describe('questions to management', () => {
  it('go to the managers of the home hotel and the answer comes back', async () => {
    const q = await call(ctx, 'POST', '/me/questions', emp.maria!, {
      subject: 'Urlaub Weihnachten',
      body: 'Kann ich zwischen den Jahren frei bekommen?',
    });
    expect(q.status).toBe(201);
    expect((await call(ctx, 'POST', '/me/questions', emp.maria!, { subject: '', body: 'x' })).status).toBe(
      400,
    );
    expect((await call(ctx, 'GET', '/approvals/count', fx.mgrA1.token)).body.questions).toBe(1);
    const open = await call(ctx, 'GET', `/questions?hotelIds=${fx.hotelA1}`, fx.mgrA1.token);
    expect(open.body.items[0]).toMatchObject({
      displayName: 'Maria T.',
      subject: 'Urlaub Weihnachten',
      status: 'open',
    });
    expect((await call(ctx, 'GET', `/questions?hotelIds=${fx.hotelA1}`, fx.mgrA2.token)).status).toBe(403);
    expect(
      (await call(ctx, 'PUT', `/questions/${q.body.id}/answer`, fx.mgrA2.token, { answer: 'ja' })).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'PUT', `/questions/${q.body.id}/answer`, fx.mgrA1.token, {
          answer: 'Ja, bitte als Antrag stellen.',
        })
      ).body.status,
    ).toBe('answered');
    const mine = await call(ctx, 'GET', '/me/questions', emp.maria!);
    expect(mine.body.items[0]).toMatchObject({ status: 'answered', answer: 'Ja, bitte als Antrag stellen.' });
    expect((await call(ctx, 'GET', '/me/questions', emp.jon!)).body.items).toEqual([]);
    expect(
      (
        await ctx.db
          .selectFrom('notification')
          .select('kind')
          .where('kind', 'in', ['question_asked', 'question_answered'])
          .execute()
      )
        .map((n) => n.kind)
        .filter((k, i, a) => a.indexOf(k) === i)
        .sort(),
    ).toEqual(['question_answered', 'question_asked']);
    expect((await call(ctx, 'GET', '/approvals/count', fx.mgrA1.token)).body.questions).toBe(0);
  });
});

describe('feed', () => {
  it('is a hotel board: posts, comments, likes, deletion by the author or the planners, privacy of other hotels', async () => {
    const p1 = await call(ctx, 'POST', '/feed/posts', emp.maria!, {
      hotelId: fx.hotelA1,
      body: 'Frühstückskarte neu!',
    });
    expect(p1.status).toBe(201);
    expect(p1.body.author).toBe('Maria T.');
    expect(
      (await call(ctx, 'POST', '/feed/posts', emp.maria!, { hotelId: fx.hotelB1, body: 'x' })).status,
    ).toBe(403);
    expect(
      (await call(ctx, 'POST', '/feed/posts', emp.maria!, { hotelId: fx.hotelA1, body: '   ' })).status,
    ).toBe(400);
    expect(
      (await call(ctx, 'POST', `/feed/posts/${p1.body.id}/comments`, emp.jon!, { body: 'Super' })).status,
    ).toBe(201);
    expect((await call(ctx, 'PUT', `/feed/posts/${p1.body.id}/like`, emp.jon!)).body).toMatchObject({
      liked: true,
      likes: 1,
    });
    const mgrPost = await call(ctx, 'POST', '/feed/posts', fx.mgrA1.token, {
      hotelId: fx.hotelA1,
      body: 'Dienstplan ab Freitag online',
    });
    expect(mgrPost.body.author).toMatch(/^Markus? |^M\w+ \w\.$/);
    const feed = await call(ctx, 'GET', '/feed', emp.jon!);
    expect(feed.body.items.map((x: any) => x.body)).toEqual([
      'Dienstplan ab Freitag online',
      'Frühstückskarte neu!',
    ]);
    const first = feed.body.items[1];
    expect(first).toMatchObject({
      likes: 1,
      likedByMe: true,
      canDelete: false,
      comments: [{ author: 'Jon T.', body: 'Super' }],
    });
    expect((await call(ctx, 'PUT', `/feed/posts/${p1.body.id}/like`, emp.jon!)).body).toMatchObject({
      liked: false,
      likes: 0,
    });
    // other hotels and other companies see nothing
    expect((await call(ctx, 'GET', `/feed?hotelId=${fx.hotelA2}`, emp.maria!)).status).toBe(403);
    expect((await call(ctx, 'GET', `/feed?hotelId=${fx.hotelA1}`, fx.adminB.token)).status).toBe(403);
    expect((await call(ctx, 'GET', '/feed', emp.piotr!)).body.items).toHaveLength(2); // housekeeping colleague of the same hotel
    // deletion: only author or planners
    expect((await call(ctx, 'DELETE', `/feed/posts/${p1.body.id}`, emp.jon!)).status).toBe(403);
    expect((await call(ctx, 'DELETE', `/feed/posts/${p1.body.id}`, fx.mgrA2.token)).status).toBe(403);
    expect((await call(ctx, 'DELETE', `/feed/posts/${p1.body.id}`, fx.mgrA1.token)).status).toBe(204);
    expect((await call(ctx, 'DELETE', `/feed/posts/${p1.body.id}`, fx.mgrA1.token)).status).toBe(404);
    expect((await call(ctx, 'DELETE', `/feed/posts/${mgrPost.body.id}`, fx.mgrA1.token)).status).toBe(204);
    const acts = await ctx.db
      .selectFrom('audit_log')
      .select('action')
      .where('entity_type', '=', 'feed_post')
      .execute();
    expect(acts.map((a) => a.action)).toEqual(
      expect.arrayContaining(['feed_post_created', 'feed_post_moderated']),
    );
    // switched off
    await call(ctx, 'PUT', `/settings/features?companyId=${fx.companyA}`, fx.adminA.token, {
      feature: 'feed',
      enabled: false,
    });
    expect((await call(ctx, 'GET', '/feed', emp.jon!)).body.error.code).toBe('FEATURE_DISABLED');
    await call(ctx, 'PUT', `/settings/features?companyId=${fx.companyA}`, fx.adminA.token, {
      feature: 'feed',
      enabled: true,
    });
  });
});

describe('calendar subscription', () => {
  it('rotates a secret token, serves the published shifts as .ics and stops after revocation', async () => {
    await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.maria,
      shiftId: fx.early,
      date: '2026-11-03',
    });
    await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.maria,
      shiftId: fx.late,
      date: '2026-11-04',
    });
    await call(ctx, 'POST', '/schedule/publish', fx.adminA.token, {
      hotelIds: [fx.hotelA1],
      from: '2026-11-02',
      to: '2026-11-08',
    });
    await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.maria,
      shiftId: fx.early,
      date: '2026-11-05',
    }); // draft: not in the feed
    await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
      employeeId: fx.emp.maria,
      from: '2026-11-09',
      to: '2026-11-10',
      type: 'annual_leave',
    });
    const c = await call(ctx, 'POST', '/me/calendar-feed', emp.maria!);
    expect(c.status).toBe(201);
    const row = await ctx.db.selectFrom('calendar_feed').selectAll().executeTakeFirstOrThrow();
    expect(row.token_hash).not.toContain(c.body.token); // only the hash is stored
    const feed = await get(c.body.path.replace('/api/v1', ''));
    expect(feed.statusCode).toBe(200);
    expect(feed.headers['content-type']).toContain('text/calendar');
    expect(feed.body).toContain('BEGIN:VCALENDAR');
    expect(feed.body.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(feed.body).toContain('SUMMARY:Dienst Früh');
    expect(feed.body).toContain('DTSTART:20261103T050000Z'); // 06:00 CET
    expect(feed.body).toContain('DTSTART;VALUE=DATE:20261109');
    expect(feed.body).toContain('DTEND;VALUE=DATE:20261111');
    expect(feed.body).not.toMatch(/annual|Urlaub|sick/i);
    expect(feed.body.split('\r\n').every((l: string) => Buffer.byteLength(l) <= 75)).toBe(true);
    // rotating invalidates the old URL
    const c2 = await call(ctx, 'POST', '/me/calendar-feed', emp.maria!);
    expect((await get(c.body.path.replace('/api/v1', ''))).statusCode).toBe(404);
    expect((await get(c2.body.path.replace('/api/v1', ''))).statusCode).toBe(200);
    expect((await get('/feeds/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.ics')).statusCode).toBe(404);
    expect((await get('/feeds/short.ics')).statusCode).toBe(400);
    expect((await call(ctx, 'DELETE', '/me/calendar-feed', emp.maria!)).status).toBe(204);
    expect((await get(c2.body.path.replace('/api/v1', ''))).statusCode).toBe(404);
    expect((await call(ctx, 'POST', '/me/calendar-feed', fx.adminA.token)).status).toBe(403);
  });

  it('escapes and folds lines', () => {
    const ics = icsCalendar({
      name: 'A;B',
      events: [
        {
          uid: 'x',
          summary: 'Früh, Spät; "Test"\nZeile 2',
          location: 'Hotel Nr. 1 mit sehr langem Namen '.repeat(4),
          start: new Date('2026-11-03T05:00:00Z'),
          end: new Date('2026-11-03T13:00:00Z'),
        },
      ],
    });
    expect(ics).toContain('SUMMARY:Früh\\, Spät\\; "Test"\\nZeile 2');
    expect(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(fold('A'.repeat(200)).length).toBeGreaterThan(2);
  });
});

describe('team absences', () => {
  it('show colleagues as away without reason or sickness, only when the company allows it', async () => {
    await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
      employeeId: fx.emp.jon,
      from: '2026-12-07',
      to: '2026-12-08',
      type: 'annual_leave',
    });
    await call(ctx, 'POST', '/schedule/absence', fx.adminA.token, {
      employeeId: fx.emp.tom,
      from: '2026-12-09',
      to: '2026-12-09',
      type: 'sick_leave',
    });
    const q = '/me/team-absences?from=2026-12-01&to=2026-12-31';
    expect((await call(ctx, 'GET', q, emp.maria!)).body).toEqual({ enabled: false, items: [] });
    expect(
      (await call(ctx, 'PUT', '/settings/team-visibility', fx.mgrA1.token, { value: 'names_only' })).status,
    ).toBe(403);
    expect(
      (await call(ctx, 'PUT', '/settings/team-visibility', fx.adminA.token, { value: 'names_only' })).status,
    ).toBe(200);
    const on = await call(ctx, 'GET', q, emp.maria!);
    expect(on.body.enabled).toBe(true);
    expect(on.body.items).toEqual([{ displayName: 'Jon T.', from: '2026-12-07', to: '2026-12-08' }]); // no sickness, no type
    expect(JSON.stringify(on.body)).not.toMatch(/sick|annual|Tom/);
    expect((await call(ctx, 'GET', q, emp.piotr!)).body.items).toEqual([]); // other department
    await call(ctx, 'PUT', `/settings/features?companyId=${fx.companyA}`, fx.adminA.token, {
      feature: 'team_calendar',
      enabled: false,
    });
    expect((await call(ctx, 'GET', q, emp.maria!)).body.enabled).toBe(false);
    await call(ctx, 'PUT', `/settings/features?companyId=${fx.companyA}`, fx.adminA.token, {
      feature: 'team_calendar',
      enabled: true,
    });
  });
});
