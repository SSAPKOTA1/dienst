import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
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
let token: string;
let emp: Record<string, string>;
const at = (iso: string) => (ctx.now.value = new Date(iso));

const k = (method: string, url: string, body?: unknown, tok: string | null = token) =>
  ctx.app
    .inject({
      method: method as any,
      url: `/api/v1${url}`,
      headers: tok ? { 'x-kiosk-token': tok } : {},
      payload: body as object | undefined,
    })
    .then((r) => ({ status: r.statusCode, body: r.json() as any }));
const ref = async (name: string) =>
  (await k('GET', `/kiosk/search?q=${name}`)).body.items[0].employeeRef as string;
const web = (method: string, url: string, tok: string, body?: unknown, ip = '10.1.2.3') =>
  ctx.app
    .inject({
      method: method as any,
      url: `/api/v1${url}`,
      headers: auth(tok),
      remoteAddress: ip,
      payload: body as object,
    })
    .then((r) => ({ status: r.statusCode, body: r.json() as any }));
const settings = (body: unknown, tok = fx.adminA.token) =>
  call(ctx, 'PUT', `/hotels/${fx.hotelA1}/settings`, tok, body);

beforeAll(async () => {
  ctx = await startApp({ now: new Date('2026-10-12T05:00:00Z') });
  ctxHolder.ctx = ctx;
  fx = await planFixture(ctx);
  token = (
    await call(ctx, 'POST', '/kiosk-devices', fx.adminA.token, { hotelId: fx.hotelA1, name: 'Rezeption' })
  ).body.token;
  emp = await employeeTokens(ctx, fx, ['maria', 'jon']);
});
afterAll(async () => stopApp(ctx));

describe('hotel settings', () => {
  it('admins edit break mode, badge mode and web punch; managers and bad input are refused', async () => {
    expect((await settings({ breakMode: 'start_stop' }, fx.mgrA1.token)).status).toBe(403);
    expect((await settings({})).status).toBe(400);
    expect((await settings({ allowWebPunch: true })).status).toBe(400); // needs a network
    expect((await settings({ webPunchAllowedCidrs: ['not-an-ip'] })).status).toBe(400);
    expect((await settings({ webPunchAllowedCidrs: ['10.0.0.0/33'] })).status).toBe(400);
    const ok = await settings({ breakMode: 'start_stop', kioskIdentification: 'badge_pin' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      breakMode: 'start_stop',
      kioskIdentification: 'badge_pin',
      allowWebPunch: false,
    });
    expect(
      (await call(ctx, 'PUT', `/hotels/${fx.hotelB1}/settings`, fx.adminA.token, { breakMode: 'start_stop' }))
        .status,
    ).toBe(403);
    const audit = await ctx.db
      .selectFrom('audit_log')
      .select('id')
      .where('action', '=', 'hotel_settings_updated')
      .execute();
    expect(audit.length).toBe(1);
    await settings({ breakMode: 'confirm_at_clock_out', kioskIdentification: 'name_pin' });
  });
});

describe('break start/stop', () => {
  it('is refused while the hotel uses the confirmation at clock-out', async () => {
    const e = await ref('Maria');
    expect((await k('POST', '/kiosk/break-start', { employeeRef: e, pin: fx.pin.maria })).status).toBe(409);
  });

  it('records segments, counts only segments of 15 minutes or more and ends an open one at clock-out', async () => {
    await settings({ breakMode: 'start_stop' });
    const e = await ref('Maria');
    const pin = fx.pin.maria;
    at('2026-10-12T05:00:00Z');
    expect((await k('POST', '/kiosk/punch-in', { employeeRef: e, pin })).status).toBe(200);
    expect((await k('POST', '/kiosk/break-end', { employeeRef: e, pin })).status).toBe(409); // no break running
    at('2026-10-12T08:00:00Z');
    expect((await k('POST', '/kiosk/break-start', { employeeRef: e, pin })).status).toBe(200);
    expect((await k('POST', '/kiosk/break-start', { employeeRef: e, pin })).status).toBe(409);
    const roster = await k('GET', '/kiosk/roster');
    expect(roster.body.breakMode).toBe('start_stop');
    expect(roster.body.items.find((i: any) => i.displayName === 'Maria T.').state).toBe('on_break');
    at('2026-10-12T08:10:00Z'); // 10 minutes: too short to count
    const short = await k('POST', '/kiosk/break-end', { employeeRef: e, pin });
    expect(short.body).toMatchObject({ onBreak: false, breakMinutes: 0 });
    at('2026-10-12T09:00:00Z');
    await k('POST', '/kiosk/break-start', { employeeRef: e, pin });
    at('2026-10-12T09:20:00Z');
    expect((await k('POST', '/kiosk/break-end', { employeeRef: e, pin })).body.breakMinutes).toBe(20);
    at('2026-10-12T10:00:00Z');
    await k('POST', '/kiosk/break-start', { employeeRef: e, pin }); // never ended
    at('2026-10-12T11:00:00Z'); // 7 h gross
    const out = await k('POST', '/kiosk/punch-out', { employeeRef: e, pin });
    expect(out.body.recordedBreakMinutes).toBe(80);
    expect(out.body.suggestedBreakMinutes).toBe(80);
    expect(out.body.options).toContain(80);
    const done = await k('POST', '/kiosk/punch-out/confirm-break', {
      confirmToken: out.body.confirmToken,
      actualBreakMinutes: 80,
    });
    expect(done.status).toBe(200);
    const rec = await ctx.db
      .selectFrom('punch_record')
      .selectAll()
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    const segs = rec.break_segments as Array<{ start: string; end: string | null }>;
    expect(segs).toHaveLength(3);
    expect(segs.every((s) => s.end)).toBe(true);
    expect(rec.actual_break_minutes).toBe(80);
  });
});

describe('badge identification', () => {
  it('assigns a badge shown once, identifies at the tablet, still needs the PIN, and rejects duplicates', async () => {
    const maria = fx.emp.maria;
    const a = await call(ctx, 'POST', `/employees/${maria}/badge`, fx.adminA.token, {});
    expect(a.status).toBe(200);
    expect(a.body.badge).toMatch(/^B-/);
    expect(a.body.qrDataUrl).toMatch(/^data:image\/png/);
    const row = await ctx.db
      .selectFrom('employee')
      .select('badge_hash')
      .where('employee_id', '=', maria)
      .executeTakeFirstOrThrow();
    expect(row.badge_hash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(a.body.badge);
    expect((await call(ctx, 'GET', `/employees/${maria}`, fx.adminA.token)).body.hasBadge).toBe(true);
    // name + PIN mode: the badge route does not exist for the tablet
    expect((await k('POST', '/kiosk/badge', { badge: a.body.badge })).status).toBe(404);
    await settings({ kioskIdentification: 'badge_pin' });
    const hit = await k('POST', '/kiosk/badge', { badge: a.body.badge });
    expect(hit.status).toBe(200);
    expect(hit.body.displayName).toBe('Maria T.');
    expect((await k('POST', '/kiosk/badge', { badge: 'B-UNKNOWN-BADGE' })).status).toBe(404);
    // the reference still needs the PIN
    expect(
      (await k('POST', '/kiosk/punch-in', { employeeRef: hit.body.employeeRef, pin: '000000' })).status,
    ).toBe(401);
    // same badge for someone else
    const dup = await call(ctx, 'POST', `/employees/${fx.emp.jon}/badge`, fx.adminA.token, {
      badge: a.body.badge,
    });
    expect(dup.status).toBe(409);
    expect((await call(ctx, 'POST', `/employees/${fx.emp.jon}/badge`, fx.mgrA1.token, {})).status).toBe(403);
    expect((await call(ctx, 'POST', `/employees/${fx.emp.jon}/badge`, fx.adminB.token, {})).status).toBe(403);
    expect((await call(ctx, 'DELETE', `/employees/${maria}/badge`, fx.adminA.token)).status).toBe(204);
    expect((await k('POST', '/kiosk/badge', { badge: a.body.badge })).status).toBe(404);
    await settings({ kioskIdentification: 'name_pin' });
  });
});

describe('offline kiosk', () => {
  it('syncs queued punches once, forces review, rejects wrong PINs and stale items', async () => {
    at('2026-10-13T06:00:00Z');
    await call(ctx, 'POST', '/schedule/entries', fx.adminA.token, {
      hotelId: fx.hotelA1,
      employeeId: fx.emp.jon,
      shiftId: fx.early,
      date: '2026-10-13',
    });
    await call(ctx, 'POST', '/schedule/publish', fx.adminA.token, {
      hotelIds: [fx.hotelA1],
      from: '2026-10-13',
      to: '2026-10-13',
    });
    const roster = await k('GET', '/kiosk/offline-roster');
    expect(roster.body.items.map((i: any) => i.displayName)).toEqual(['Jon T.']); // only today's roster
    expect(roster.status).toBe(200);
    const jon = roster.body.items.find((i: any) => i.displayName === 'Jon T.');
    expect(jon.offlineRef).toBeTruthy();
    const inAt = '2026-10-13T05:00:00Z';
    const outAt = '2026-10-13T11:30:00Z';
    at('2026-10-13T12:00:00Z');
    const items = [
      {
        clientId: 'cid-0000-0001',
        action: 'in',
        occurredAt: inAt,
        offlineRef: jon.offlineRef,
        pin: fx.pin.jon,
      },
      {
        clientId: 'cid-0000-0002',
        action: 'out',
        occurredAt: outAt,
        offlineRef: jon.offlineRef,
        pin: fx.pin.jon,
        breakMinutes: 30,
      },
      {
        clientId: 'cid-0000-0003',
        action: 'in',
        occurredAt: '2026-10-13T11:45:00Z',
        offlineRef: jon.offlineRef,
        pin: '000000',
      },
      {
        clientId: 'cid-0000-0004',
        action: 'in',
        occurredAt: '2026-10-11T05:00:00Z',
        offlineRef: jon.offlineRef,
        pin: fx.pin.jon,
      },
    ];
    const res = await k('POST', '/kiosk/offline-sync', { items });
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.results.map((r: any) => [r.clientId, r]));
    expect(byId['cid-0000-0001'].status).toBe('applied');
    expect(byId['cid-0000-0002'].status).toBe('applied');
    expect(byId['cid-0000-0003']).toMatchObject({ status: 'rejected', code: 'PIN_INVALID' });
    expect(byId['cid-0000-0004']).toMatchObject({ status: 'rejected', code: 'VALIDATION' });
    const rec = await ctx.db
      .selectFrom('punch_record')
      .selectAll()
      .where('source', '=', 'kiosk_offline')
      .executeTakeFirstOrThrow();
    expect(rec.offline_punch).toBe(true);
    expect(rec.approval_status).toBe('pending'); // never auto-approved
    expect(rec.actual_punch_in.toISOString()).toBe('2026-10-13T05:00:00.000Z');
    expect(rec.actual_punch_out!.toISOString()).toBe('2026-10-13T11:30:00.000Z');
    const inbox = await call(ctx, 'GET', '/approvals?type=worked_time&status=pending', fx.mgrA1.token);
    expect(inbox.body.items.find((i: any) => i.id === rec.id).flags).toContain('offline');
    const bulk = await call(ctx, 'POST', '/approvals/worked-time/bulk-approve', fx.mgrA1.token, {
      ids: [rec.id],
    });
    expect(JSON.stringify(bulk.body)).toContain('flagged');
    // resend: idempotent
    const again = await k('POST', '/kiosk/offline-sync', { items: items.slice(0, 2) });
    expect(again.body.results.map((r: any) => r.status)).toEqual(['duplicate', 'duplicate']);
    expect(await ctx.db.selectFrom('punch_record').select('id').execute()).toHaveLength(2);
    // planners hear about rejected items
    const notes = await ctx.db
      .selectFrom('notification')
      .select('kind')
      .where('kind', '=', 'offline_punch_rejected')
      .execute();
    expect(notes.length).toBeGreaterThanOrEqual(2);
    // another tablet cannot use the references
    const other = await call(ctx, 'POST', '/kiosk-devices', fx.adminA.token, {
      hotelId: fx.hotelA1,
      name: 'Other',
    });
    const x = await k(
      'POST',
      '/kiosk/offline-sync',
      { items: [{ ...items[0], clientId: 'cid-0000-0099' }] },
      other.body.token,
    );
    expect(x.body.results[0]).toMatchObject({ status: 'rejected', code: 'UNAUTHENTICATED' });
  });
});

describe('web punch', () => {
  it('is off by default, limited to the hotel network and always goes to review', async () => {
    at('2026-10-14T06:00:00Z');
    const off = await web('GET', '/me/punch', emp.maria);
    expect(off.body).toMatchObject({ enabled: false, hotels: [], open: null });
    expect((await web('POST', '/me/punch/in', emp.maria, { hotelId: fx.hotelA1 })).status).toBe(403);
    expect(
      (await settings({ allowWebPunch: true, webPunchAllowedCidrs: ['10.0.0.0/8', '2001:db8::/32'] })).status,
    ).toBe(200);
    const on = await web('GET', '/me/punch', emp.maria);
    expect(on.body.enabled).toBe(true);
    expect(on.body.hotels[0]).toMatchObject({ hotelId: fx.hotelA1, networkOk: true });
    expect(
      (await web('GET', '/me/punch', emp.maria, undefined, '203.0.113.9')).body.hotels[0].networkOk,
    ).toBe(false);
    const blocked = await web('POST', '/me/punch/in', emp.maria, { hotelId: fx.hotelA1 }, '203.0.113.9');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.details.reason).toBe('NETWORK');
    // not a member of that hotel
    expect((await web('POST', '/me/punch/in', emp.maria, { hotelId: fx.hotelA2 })).status).toBe(403);
    // v4-mapped and v6 addresses
    expect(
      (await web('GET', '/me/punch', emp.maria, undefined, '::ffff:10.9.9.9')).body.hotels[0].networkOk,
    ).toBe(true);
    expect(
      (await web('GET', '/me/punch', emp.maria, undefined, '2001:db8::7')).body.hotels[0].networkOk,
    ).toBe(true);

    const inn = await web('POST', '/me/punch/in', emp.maria, { hotelId: fx.hotelA1 });
    expect(inn.status).toBe(200);
    expect(inn.body.isUnplanned).toBe(true);
    expect((await web('POST', '/me/punch/in', emp.maria, { hotelId: fx.hotelA1 })).body.punchRecordId).toBe(
      inn.body.punchRecordId,
    ); // double tap
    at('2026-10-14T13:00:00Z');
    const st = await web('GET', '/me/punch', emp.maria);
    expect(st.body.open).toMatchObject({ source: 'web', requiredBreakMinutes: 30 });
    const short = await web('POST', '/me/punch/out', emp.maria, { breakMinutes: 0 });
    expect(short.body.error.code).toBe('REASON_REQUIRED');
    const out = await web('POST', '/me/punch/out', emp.maria, { breakMinutes: 30 });
    expect(out.status).toBe(200);
    expect(out.body.approvalStatus).toBe('pending');
    const rec = await ctx.db
      .selectFrom('punch_record')
      .selectAll()
      .where('source', '=', 'web')
      .executeTakeFirstOrThrow();
    expect(rec.kiosk_device_id).toBeNull();
    const inbox = await call(ctx, 'GET', '/approvals?type=worked_time&status=pending', fx.mgrA1.token);
    expect(inbox.body.items.find((i: any) => i.id === rec.id).flags).toContain('web');
    // switching it off again closes the door
    await settings({ allowWebPunch: false });
    expect((await web('POST', '/me/punch/in', emp.jon, { hotelId: fx.hotelA1 })).status).toBe(403);
    // managers have no punch
    expect((await web('GET', '/me/punch', fx.mgrA1.token)).status).toBe(403);
  });
});
