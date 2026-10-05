// Exact boundary and payload tests for the legal checks (found by mutation testing: the code was only covered through vectors).
import { describe, expect, it } from 'vitest';
import {
  absenceLimitIssues,
  aggregate,
  availabilityConflicts,
  categoryMinutes,
  checkEntry,
  DEFAULT_CATEGORIES,
  DEFAULT_LIMITS,
  mergeLimits,
  nightMinutesOf,
  overlapsNightWindow,
  qualificationIssue,
  restCompensations,
  suggestHeadcount,
  sundaysInYear,
  validateCategoryRule,
  validateLimits,
  validOverrideReason,
  wishConflicts,
  type CheckInput,
  type RuleOther,
} from '../src';

const H = 3600_000;
const MIN = 60_000;
const T0 = Date.UTC(2027, 5, 7, 6, 0); // Monday 07:00 local, summer time

const entry = (over: Partial<CheckInput['entry']> = {}, working = 480, brk = 30): CheckInput['entry'] => ({
  id: 1,
  hotelId: 1,
  departmentId: 1,
  shiftId: 5,
  startMs: T0,
  endMs: T0 + (working + brk) * MIN,
  breakMinutes: brk,
  localDate: '2027-06-07',
  startLocalMin: 8 * 60,
  endLocalMin: 8 * 60 + working + brk,
  ...over,
});
const input = (over: Partial<CheckInput> = {}, e: Partial<CheckInput['entry']> = {}): CheckInput => ({
  entry: entry(e),
  employee: { dateOfBirth: '1990-01-01', active: true, hotelIds: [1], departmentIds: [1] },
  contractActive: true,
  monthlyHoursCap: null,
  others: [],
  absenceOnDay: false,
  periodClosed: false,
  today: '2027-06-01',
  ...over,
});
const other = (
  startMs: number,
  endMs: number,
  localDate: string,
  over: Partial<RuleOther> = {},
): RuleOther => ({
  id: 7,
  startMs,
  endMs,
  breakMinutes: 0,
  localDate,
  ...over,
});
const find = (i: CheckInput, code: string) => checkEntry(i).filter((x) => x.code === code);

describe('hard conditions', () => {
  it('a clean entry has no findings', () => expect(checkEntry(input())).toEqual([]));
  it('overlap is strict: touching entries do not overlap, one minute of overlap does', () => {
    const e = entry();
    expect(find(input({ others: [other(e.endMs, e.endMs + H, '2027-06-07')] }), 'OVERLAP')).toEqual([]);
    expect(find(input({ others: [other(e.startMs - H, e.startMs, '2027-06-07')] }), 'OVERLAP')).toEqual([]);
    const hit = find(
      input({ others: [other(e.endMs - MIN, e.endMs + H, '2027-06-07', { id: 42 })] }),
      'OVERLAP',
    );
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ severity: 'block', details: { entryId: 42 } });
    expect(
      find(input({ others: [other(e.startMs - H, e.startMs + MIN, '2027-06-07')] }), 'OVERLAP'),
    ).toHaveLength(1);
  });
  it('the day in the past blocks, today does not', () => {
    expect(find(input({ today: '2027-06-08' }), 'PAST_DAY')[0]).toMatchObject({
      severity: 'block',
      details: { date: '2027-06-07' },
    });
    expect(find(input({ today: '2027-06-07' }), 'PAST_DAY')).toEqual([]);
  });
  it('each hard condition reports its own code with details', () => {
    expect(find(input({ periodClosed: true }), 'PERIOD_CLOSED')[0]).toMatchObject({
      severity: 'block',
      details: { date: '2027-06-07' },
    });
    expect(
      find(input({ employee: { ...input().employee, hotelIds: [2] } }), 'NOT_AT_HOTEL')[0],
    ).toMatchObject({ details: { hotelId: 1 } });
    expect(
      find(input({ employee: { ...input().employee, departmentIds: [9] } }), 'WRONG_DEPARTMENT')[0],
    ).toMatchObject({ details: { departmentId: 1 } });
    expect(
      find(
        {
          ...input(),
          entry: entry({ departmentId: null }),
          employee: { ...input().employee, departmentIds: [] },
        },
        'WRONG_DEPARTMENT',
      ),
    ).toEqual([]);
    expect(find(input({ absenceOnDay: true }), 'ABSENCE_CONFLICT')[0]).toMatchObject({
      details: { date: '2027-06-07' },
    });
    expect(find(input({ contractActive: false }), 'CONTRACT_INACTIVE')[0]).toMatchObject({
      details: { date: '2027-06-07' },
    });
    expect(
      find(input({ employee: { ...input().employee, active: false } }), 'CONTRACT_INACTIVE'),
    ).toHaveLength(1);
    expect(
      find(
        input({ contractActive: false, employee: { ...input().employee, active: false } }),
        'CONTRACT_INACTIVE',
      ),
    ).toHaveLength(1);
  });
  it('codes listed in skip are left out', () => {
    expect(checkEntry(input({ periodClosed: true, skip: ['PERIOD_CLOSED'] }))).toEqual([]);
    expect(checkEntry(input({ periodClosed: true, skip: ['OTHER'] }))).toHaveLength(1);
  });
});

describe('daily working time (ArbZG §3)', () => {
  it('8 h is fine, 8 h 1 min warns, 10 h warns, 10 h 1 min blocks; details carry the minutes', () => {
    expect(checkEntry(input({}, {}))).toEqual([]);
    const w = checkEntry({ ...input(), entry: entry({}, 481) });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'DAILY_OVER_8H', severity: 'warn', details: { workMinutes: 481 } });
    expect(checkEntry({ ...input(), entry: entry({}, 600) })[0]).toMatchObject({
      code: 'DAILY_OVER_8H',
      details: { workMinutes: 600 },
    });
    const b = checkEntry({ ...input(), entry: entry({}, 601) });
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ code: 'DAILY_LIMIT', severity: 'block', details: { workMinutes: 601 } });
  });
  it('adds the other entries of the same local day (split shift) but not of other days', () => {
    const e = entry({}, 300);
    const sameDay = other(e.endMs + 2 * H, e.endMs + 2 * H + 330 * MIN, '2027-06-07');
    expect(find({ ...input({ others: [sameDay] }), entry: e }, 'DAILY_LIMIT')[0]).toMatchObject({
      details: { workMinutes: 630 },
    });
    const otherDay = other(e.endMs + 20 * H, e.endMs + 20 * H + 330 * MIN, '2027-06-08');
    expect(find({ ...input({ others: [otherDay] }), entry: e }, 'DAILY_LIMIT')).toEqual([]);
  });
  it('a profile may tighten the limits', () => {
    const limits = { dailyMaxMinutes: 540, dailyWarnMinutes: 420 };
    expect(find({ ...input({ limits }), entry: entry({}, 430) }, 'DAILY_OVER_8H')).toHaveLength(1);
    expect(find({ ...input({ limits }), entry: entry({}, 541) }, 'DAILY_LIMIT')).toHaveLength(1);
    expect(find({ ...input({ limits }), entry: entry({}, 540) }, 'DAILY_LIMIT')).toEqual([]);
  });
});

describe('rest periods (ArbZG §5, hospitality exception)', () => {
  const prev = (gapMin: number, localDate = '2027-06-06') =>
    other(T0 - gapMin * MIN - 8 * H, T0 - gapMin * MIN, localDate, { id: 11 });
  it.each([
    [599, 'block'],
    [600, 'needs_reason'],
    [659, 'needs_reason'],
    [660, undefined],
  ])('a rest of %i minutes before the entry is %s', (gap, severity) => {
    const f = find(input({ others: [prev(gap)] }), 'REST_PERIOD');
    if (!severity) expect(f).toEqual([]);
    else expect(f[0]).toMatchObject({ severity, details: { gapMinutes: gap, side: 'before', entryId: 11 } });
  });
  it('checks the rest after the entry too, and takes the nearest neighbours only', () => {
    const e = entry();
    const next = other(e.endMs + 590 * MIN, e.endMs + 590 * MIN + 8 * H, '2027-06-08', { id: 12 });
    expect(find(input({ others: [next] }), 'REST_PERIOD')[0]).toMatchObject({
      severity: 'block',
      details: { gapMinutes: 590, side: 'after', entryId: 12 },
    });
    const far = other(e.endMs + 2 * 24 * 60 * MIN, e.endMs + 2 * 24 * 60 * MIN + 8 * H, '2027-06-10');
    expect(find(input({ others: [next, far] }), 'REST_PERIOD')).toHaveLength(1);
    // the neighbour that ends exactly when the entry starts has a gap of 0 and also counts as "before"
    expect(find(input({ others: [other(T0 - 8 * H, T0, '2027-06-06')] }), 'REST_PERIOD')[0]).toMatchObject({
      severity: 'block',
      details: { gapMinutes: 0 },
    });
    expect(
      find(input({ others: [other(e.endMs, e.endMs + 8 * H, '2027-06-08')] }), 'REST_PERIOD')[0],
    ).toMatchObject({ details: { gapMinutes: 0, side: 'after' } });
  });
  it('an entry on the same day is a split shift and has no rest check', () => {
    expect(find(input({ others: [prev(30, '2027-06-07')] }), 'REST_PERIOD')).toEqual([]);
  });
  it('minors need 12 hours', () => {
    const minor = { ...input().employee, dateOfBirth: '2012-01-01' };
    expect(find(input({ employee: minor, others: [prev(719)] }), 'MINOR_REST')[0]).toMatchObject({
      severity: 'block',
      details: { gapMinutes: 719, side: 'before' },
    });
    expect(find(input({ employee: minor, others: [prev(720)] }), 'MINOR_REST')).toEqual([]);
    expect(find(input({ employee: input().employee, others: [prev(700)] }), 'MINOR_REST')).toEqual([]);
  });
});

describe('minors (JArbSchG)', () => {
  it('turning 18 on the day lifts the minor rules', () => {
    const turns18 = { ...input().employee, dateOfBirth: '2009-06-07' };
    expect(
      find(input({ employee: turns18 }, { startLocalMin: 22 * 60, endLocalMin: 23 * 60 }), 'MINOR_NIGHT'),
    ).toEqual([]);
    const still17 = { ...input().employee, dateOfBirth: '2009-06-08' };
    expect(
      find(input({ employee: still17 }, { startLocalMin: 22 * 60, endLocalMin: 23 * 60 }), 'MINOR_NIGHT')[0],
    ).toMatchObject({ severity: 'block', details: { date: '2027-06-07' } });
  });
  it('more than 8 h a day blocks, exactly 8 h does not', () => {
    const minor = { ...input().employee, dateOfBirth: '2012-01-01' };
    expect(find({ ...input({ employee: minor }), entry: entry({}, 480) }, 'MINOR_DAILY')).toEqual([]);
    expect(find({ ...input({ employee: minor }), entry: entry({}, 481) }, 'MINOR_DAILY')[0]).toMatchObject({
      details: { workMinutes: 481 },
    });
  });
  it('the night window is 20:00-06:00 including entries that end after midnight', () => {
    expect(overlapsNightWindow(8 * 60, 19 * 60 + 59)).toBe(false);
    expect(overlapsNightWindow(8 * 60, 20 * 60)).toBe(false);
    expect(overlapsNightWindow(8 * 60, 20 * 60 + 1)).toBe(true);
    expect(overlapsNightWindow(6 * 60, 12 * 60)).toBe(false);
    expect(overlapsNightWindow(5 * 60 + 59, 12 * 60)).toBe(true);
    expect(overlapsNightWindow(0, 1)).toBe(true);
    expect(overlapsNightWindow(1439, 1441)).toBe(true);
    expect(overlapsNightWindow(1440 + 6 * 60, 1440 + 12 * 60)).toBe(false); // the next day after 06:00
    expect(overlapsNightWindow(2 * 1440 + 60, 2 * 1440 + 120)).toBe(true); // two days later, 01:00
  });
});

describe('monthly hours cap (warning)', () => {
  const day = (n: number) => `2027-06-${String(n).padStart(2, '0')}`;
  it('adds the other entries of the same month only and warns above the cap, not at it', () => {
    const e = entry({}, 480);
    const o = (d: string, mins: number) => other(T0 + 3 * 24 * H, T0 + 3 * 24 * H + mins * MIN, d);
    const i = input({ monthlyHoursCap: 16, others: [o(day(10), 480)] });
    expect(find(i, 'MONTHLY_CAP')).toEqual([]); // 8 + 8 = 16 h: at the cap
    const over = find(input({ monthlyHoursCap: 15.99, others: [o(day(10), 480)] }), 'MONTHLY_CAP');
    expect(over[0]).toMatchObject({ severity: 'warn', details: { plannedHours: 16, cap: 15.99 } });
    expect(find(input({ monthlyHoursCap: 12, others: [o('2027-07-01', 600)] }), 'MONTHLY_CAP')).toEqual([]); // another month
    void e;
    expect(find(input({ monthlyHoursCap: 7.5 }), 'MONTHLY_CAP')[0]).toMatchObject({
      details: { plannedHours: 8, cap: 7.5 },
    });
    expect(find(input({ monthlyHoursCap: 7.5, others: [o(day(10), 100)] }), 'MONTHLY_CAP')[0]).toMatchObject({
      details: { plannedHours: 9.67 },
    });
  });
});

describe('Sunday and night statistics', () => {
  const sunday = { localDate: '2027-06-06' }; // a Sunday
  it('warns when fewer than 15 Sundays remain free in the year, counting the entry itself once', () => {
    const sundays = sundaysInYear(2027); // 52
    // distinct Sundays of 2027 other than the entry's own (6 June)
    const allSundays = Array.from({ length: sundays }, (_, k) =>
      new Date(Date.UTC(2027, 0, 3 + 7 * k)).toISOString().slice(0, 10),
    ).filter((d) => d !== sunday.localDate);
    const worked = (n: number) => allSundays.slice(0, n);
    const e = { startLocalMin: 600, endLocalMin: 1000, ...sunday };
    const ok = find(input({ calendar: { sundayDates: worked(36), nightDates: [] } }, e), 'SUNDAY_LIMIT'); // 52 - 37 = 15 free
    expect(ok).toEqual([]);
    const bad = find(input({ calendar: { sundayDates: worked(37), nightDates: [] } }, e), 'SUNDAY_LIMIT'); // 52 - 38 = 14
    expect(bad[0]).toMatchObject({ severity: 'warn', details: { freeSundays: sundays - 38, required: 15 } });
    // the same Sunday listed twice (once as the entry itself) is not counted twice
    const again = find(
      input({ calendar: { sundayDates: [...worked(36), sunday.localDate], nightDates: [] } }, e),
      'SUNDAY_LIMIT',
    );
    expect(again).toEqual([]);
    // other years do not count; weekdays have no Sunday check at all
    const prevYear = Array.from({ length: 40 }, (_, k) => `2026-0${1 + (k % 9)}-0${1 + (k % 9)}`);
    expect(find(input({ calendar: { sundayDates: prevYear, nightDates: [] } }, e), 'SUNDAY_LIMIT')).toEqual(
      [],
    );
    expect(find(input({ calendar: { sundayDates: worked(50), nightDates: [] } }), 'SUNDAY_LIMIT')).toEqual(
      [],
    );
  });
  it('flags a night worker from the 48th night in the last 12 months (this one included), only for night entries', () => {
    const nights = (n: number) =>
      Array.from(
        { length: n },
        (_, k) =>
          `2026-${String(7 + Math.floor(k / 28)).padStart(2, '0')}-${String(1 + (k % 28)).padStart(2, '0')}`,
      );
    const night = { startLocalMin: 22 * 60, endLocalMin: 22 * 60 + 8 * 60 };
    expect(
      find(input({ calendar: { sundayDates: [], nightDates: nights(46) } }, night), 'NIGHT_WORKER'),
    ).toEqual([]);
    expect(
      find(input({ calendar: { sundayDates: [], nightDates: nights(47) } }, night), 'NIGHT_WORKER')[0],
    ).toMatchObject({ severity: 'warn', details: { nights: 48, from: 48 } });
    expect(find(input({ calendar: { sundayDates: [], nightDates: nights(60) } }), 'NIGHT_WORKER')).toEqual(
      [],
    ); // a day shift
    expect(
      find(
        input({ calendar: { sundayDates: [], nightDates: [...nights(47), '2027-06-07'] } }, night),
        'NIGHT_WORKER',
      )[0],
    ).toMatchObject({ details: { nights: 48 } });
  });
  it('night minutes: 23:00-06:00 in all three windows of a long entry', () => {
    expect(nightMinutesOf(0, 1440)).toBe(420); // 00:00-06:00 and 23:00-24:00
    expect(nightMinutesOf(0, 1800)).toBe(360 + 420);
    expect(nightMinutesOf(1380, 1800)).toBe(420);
    expect(nightMinutesOf(660, 1380)).toBe(0);
    expect(nightMinutesOf(1380 - 60, 1380 + 119)).toBe(119);
    expect(nightMinutesOf(1380, 1380 + 120)).toBe(120);
    expect(nightMinutesOf(2820, 3240)).toBe(420); // 23:00 of the next day to 06:00 two days later
  });
});

describe('backlog checks wired into the entry check', () => {
  it('availability, qualification and wishes are only evaluated when given', () => {
    expect(checkEntry(input())).toEqual([]);
    const availability = [
      {
        weekday: 1,
        fromMin: 480,
        toMin: 600,
        kind: 'unavailable' as const,
        validFrom: '2027-01-01',
        validTo: null,
        note: null,
      },
    ];
    expect(find(input({ availability }), 'UNAVAILABLE')[0]).toMatchObject({
      severity: 'needs_reason',
      details: { date: '2027-06-07', from: 480, to: 600 },
    });
    expect(
      find(input({ qualification: { requiredId: 3, held: [] } }), 'QUALIFICATION_MISSING')[0],
    ).toMatchObject({ severity: 'warn', details: { qualificationId: 3 } });
    const wishes = { shift: [{ date: '2027-06-07', shiftId: 99, priority: 2 }], leave: [] };
    expect(find(input({ wishes }), 'WISH_CONFLICT')[0]).toMatchObject({
      details: { kind: 'shift', priority: 2 },
    });
    expect(
      find(
        input({ wishes: { shift: [{ date: '2027-06-07', shiftId: 5, priority: 1 }], leave: [] } }),
        'WISH_CONFLICT',
      ),
    ).toEqual([]);
    // an entry without a shift id contradicts a shift wish for the day
    expect(
      find({ ...input({ wishes }), entry: entry({ shiftId: undefined }) }, 'WISH_CONFLICT'),
    ).toHaveLength(1);
  });
});

describe('aggregation and override reasons', () => {
  const vio = (code: string, severity: 'block' | 'needs_reason' | 'warn') => ({
    code,
    severity,
    message: '',
    details: {},
  });
  it('lists exactly which codes an emergency override changed', () => {
    const r = aggregate(
      [vio('DAILY_LIMIT', 'block'), vio('OVERLAP', 'block'), vio('REST_PERIOD', 'needs_reason')],
      { role: 'admin', emergencyOverride: true },
    );
    expect(r.status).toBe('blocked'); // OVERLAP stays blocked
    expect(r.overridden).toEqual(['DAILY_LIMIT']);
    expect(r.violations.map((x) => x.severity)).toEqual(['needs_reason', 'block', 'needs_reason']);
    expect(
      aggregate([vio('MINOR_REST', 'block'), vio('REST_PERIOD', 'block')], {
        role: 'superAdmin',
        emergencyOverride: true,
      }).status,
    ).toBe('needs_reason');
    expect(
      aggregate([vio('REST_PERIOD', 'block')], { role: 'manager', emergencyOverride: true }).status,
    ).toBe('blocked');
    expect(aggregate([vio('REST_PERIOD', 'block')], { role: 'admin' }).status).toBe('blocked');
    expect(aggregate([vio('MINOR_NIGHT', 'block')], { role: 'admin', emergencyOverride: true }).status).toBe(
      'blocked',
    );
    expect(aggregate([vio('X', 'warn')], { role: 'admin' }).status).toBe('ok');
    expect(aggregate([], { role: 'admin' }).status).toBe('ok');
  });
  it('an override reason has 5 to 300 characters after trimming', () => {
    expect(validOverrideReason(null)).toBe(false);
    expect(validOverrideReason(undefined)).toBe(false);
    expect(validOverrideReason('')).toBe(false);
    expect(validOverrideReason('1234')).toBe(false);
    expect(validOverrideReason('12345')).toBe(true);
    expect(validOverrideReason('    1234    ')).toBe(false);
    expect(validOverrideReason(` ${'a'.repeat(300)} `)).toBe(true);
    expect(validOverrideReason('a'.repeat(301))).toBe(false);
  });
});

describe('rest compensation boundaries', () => {
  const s = (startH: number, lenH = 8) => ({ startMs: startH * H, endMs: (startH + lenH) * H });
  const mk = (gapH: number, then: ReturnType<typeof s>[] = []) => [s(0), s(8 + gapH), ...then];
  it('lists rests from 10 h up to but excluding 11 h', () => {
    expect(restCompensations(mk(9.99), 0)).toEqual([]);
    expect(restCompensations(mk(10), 0)).toHaveLength(1);
    expect(restCompensations(mk(10.99), 0)).toHaveLength(1);
    expect(restCompensations(mk(11), 0)).toEqual([]);
  });
  it('is compensated by a later rest of at least 12 h that starts within four weeks, else open or overdue', () => {
    const first = mk(10); // gap between 8 h and 18 h; the second shift ends at 26 h
    const dueMs = 18 * H + 28 * 24 * H;
    expect(restCompensations(first, 0)[0]).toMatchObject({
      gapMinutes: 600,
      shortenedFromMs: 8 * H,
      shortenedToMs: 18 * H,
      dueMs,
      compensatedByMs: null,
      status: 'open',
    });
    const comp = (startAfterH: number, restH: number) =>
      [s(26 + restH, 8)].map((x) => ({
        startMs: x.startMs + startAfterH * H,
        endMs: x.endMs + startAfterH * H,
      }));
    expect(restCompensations([...first, ...comp(0, 12)], 0)[0]).toMatchObject({
      status: 'ok',
      compensatedByMs: 26 * H,
    });
    expect(restCompensations([...first, ...comp(0, 11.99)], 0)[0]!.status).toBe('open');
    // continuous 11 h rests (not short, not 12 h) until the due date, so only the very last rest can compensate
    const chain = (lastLenH: number, extraMs: number) => {
      const out = [...first];
      let end = 26 * H;
      for (let k = 0; k < 34; k++) {
        out.push({ startMs: end + 11 * H, endMs: end + 19 * H });
        end += 19 * H;
      }
      const start = end + 11 * H;
      out.push({ startMs: start, endMs: start + lastLenH * H + extraMs }); // ends at the due date (+ extraMs)
      const finish = start + lastLenH * H + extraMs;
      out.push({ startMs: finish + 12 * H, endMs: finish + 20 * H });
      return out;
    };
    expect(chain(7, 0)[chain(7, 0).length - 2]!.endMs).toBe(dueMs);
    expect(restCompensations(chain(7, 0), 0)[0]!.status).toBe('ok'); // the 12 h rest starts exactly at the due date
    expect(restCompensations(chain(7, 0), 0)[0]).toMatchObject({ compensatedByMs: dueMs });
    expect(restCompensations(chain(7, MIN), 0)[0]!.status).toBe('open'); // one minute too late
    // overdue only strictly after the due date
    expect(restCompensations(first, dueMs)[0]!.status).toBe('open');
    expect(restCompensations(first, dueMs + 1)[0]!.status).toBe('overdue');
  });
  it('uses the limits of the profile', () => {
    const limits = { ...DEFAULT_LIMITS, restBlockMinutes: 630, restWarnMinutes: 690 };
    expect(restCompensations(mk(10.25), 0, limits)).toEqual([]); // 615 < 630: blocked, not listed
    expect(restCompensations(mk(11), 0, limits)).toHaveLength(1);
  });
  it('sundays of a year', () => {
    expect(sundaysInYear(2026)).toBe(52);
    expect(sundaysInYear(2023)).toBe(53);
    expect(sundaysInYear(2017)).toBe(53);
    expect(sundaysInYear(2027)).toBe(52);
    expect(sundaysInYear(2028)).toBe(53); // leap year starting on a Saturday
  });
});

describe('hour categories', () => {
  const seg = (date: string, fromMin: number, toMin: number) => ({ date, fromMin, toMin });
  it('night (23:00-06:00 across midnight), Sunday, holiday and the two special evenings', () => {
    const cats = DEFAULT_CATEGORIES.map((c) => ({ code: c.code, rule: c.rule }));
    const holidays = new Set(['2026-10-03']);
    expect(categoryMinutes([seg('2026-10-06', 22 * 60, 24 * 60)], cats, holidays)).toEqual({ night: 60 });
    expect(categoryMinutes([seg('2026-10-06', 0, 7 * 60)], cats, holidays)).toEqual({ night: 360 });
    expect(categoryMinutes([seg('2026-10-06', 8 * 60, 16 * 60)], cats, holidays)).toEqual({});
    expect(categoryMinutes([seg('2026-10-04', 8 * 60, 16 * 60)], cats, holidays)).toEqual({ sunday: 480 });
    expect(categoryMinutes([seg('2026-10-03', 8 * 60, 16 * 60)], cats, holidays)).toEqual({ holiday: 480 });
    expect(categoryMinutes([seg('2026-12-24', 12 * 60, 20 * 60)], cats, holidays)).toEqual({
      special_eve: 360,
    });
    expect(categoryMinutes([seg('2026-12-31', 15 * 60, 23 * 60)], cats, holidays)).toEqual({
      special_eve: 480,
    });
    expect(categoryMinutes([seg('2026-12-23', 12 * 60, 20 * 60)], cats, holidays)).toEqual({});
    // a Sunday night counts for both categories, and minutes add up over segments
    expect(
      categoryMinutes([seg('2026-10-04', 22 * 60, 24 * 60), seg('2026-10-05', 0, 60)], cats, holidays),
    ).toEqual({ night: 120, sunday: 120 });
  });
  it('a daily window that does not cross midnight, parsed with minutes', () => {
    const cats = [{ code: 'x', rule: { daily: { from: '08:30', to: '12:15' } } }];
    expect(categoryMinutes([seg('2026-10-06', 9 * 60, 13 * 60)], cats, new Set())).toEqual({ x: 195 });
    expect(categoryMinutes([seg('2026-10-06', 6 * 60, 8 * 60 + 30)], cats, new Set())).toEqual({});
    const same = [{ code: 'y', rule: { daily: { from: '10:00', to: '10:00' } } }];
    expect(categoryMinutes([seg('2026-10-06', 0, 1440)], same, new Set())).toEqual({}); // from == to is an empty window, not a whole day
  });
  it('the default categories are the four documented ones', () => {
    expect(DEFAULT_CATEGORIES.map((c) => c.code)).toEqual(['night', 'sunday', 'holiday', 'special_eve']);
    expect(DEFAULT_CATEGORIES.every((c) => c.name.length > 3)).toBe(true);
    expect(DEFAULT_CATEGORIES[1]!.rule).toEqual({ weekday: 7 });
    expect(DEFAULT_CATEGORIES[2]!.rule).toEqual({ holiday: true });
    expect(DEFAULT_CATEGORIES[3]!.rule).toEqual({ dates: ['12-24', '12-31'], from: '14:00', to: '24:00' });
    expect(DEFAULT_CATEGORIES[0]!.rule).toEqual({ daily: { from: '23:00', to: '06:00' } });
  });
  it('validates rules from the admin UI', () => {
    const ok = [
      { daily: { from: '23:00', to: '06:00' } },
      { daily: { from: '00:00', to: '24:00' } },
      { weekday: 1 },
      { weekday: 7 },
      { holiday: true },
      { dates: ['12-24'], from: '14:00', to: '24:00' },
      { dates: ['01-31', '02-30'], from: '00:00', to: '23:59' },
    ];
    for (const r of ok) expect(validateCategoryRule(r)).toBeNull();
    const bad: Array<[unknown, string]> = [
      [null, 'rule must be an object'],
      ['x', 'rule must be an object'],
      [{}, 'exactly one of daily, weekday, holiday, dates'],
      [{ weekday: 1, holiday: true }, 'exactly one of daily, weekday, holiday, dates'],
      [{ daily: { from: '24:01', to: '06:00' } }, 'daily needs from and to as HH:mm'],
      [{ daily: { from: '7:00', to: '06:00' } }, 'daily needs from and to as HH:mm'],
      [{ daily: { from: '23:00' } }, 'daily needs from and to as HH:mm'],
      [{ daily: { from: '23:00', to: '06:00 ' } }, 'daily needs from and to as HH:mm'],
      [{ daily: { from: ' 23:00', to: '06:00' } }, 'daily needs from and to as HH:mm'],
      [{ daily: { from: '23:00', to: '06:00x' } }, 'daily needs from and to as HH:mm'],
      [{ daily: { from: '99:00', to: '06:00' } }, 'daily needs from and to as HH:mm'],
      [{ daily: null }, 'daily needs from and to as HH:mm'],
      [{ weekday: 0 }, 'weekday 1-7'],
      [{ weekday: 8 }, 'weekday 1-7'],
      [{ weekday: 1.5 }, 'weekday 1-7'],
      [{ weekday: '3' }, 'weekday 1-7'],
      [{ holiday: false }, 'holiday must be true'],
      [{ dates: [], from: '14:00', to: '24:00' }, 'dates as MM-DD list'],
      [{ dates: 'x', from: '14:00', to: '24:00' }, 'dates as MM-DD list'],
      [{ dates: ['13-01'], from: '14:00', to: '24:00' }, 'dates as MM-DD list'],
      [{ dates: ['00-10'], from: '14:00', to: '24:00' }, 'dates as MM-DD list'],
      [{ dates: ['01-00'], from: '14:00', to: '24:00' }, 'dates as MM-DD list'],
      [{ dates: ['12-32'], from: '14:00', to: '24:00' }, 'dates as MM-DD list'],
      [{ dates: ['12-24', 'x'], from: '14:00', to: '24:00' }, 'dates as MM-DD list'],
      [{ dates: ['2026-12-24'], from: '14:00', to: '24:00' }, 'dates as MM-DD list'],
      [{ dates: ['12-24x'], from: '14:00', to: '24:00' }, 'dates as MM-DD list'],
      [{ dates: ['x12-24'], from: '14:00', to: '24:00' }, 'dates as MM-DD list'],
      [{ dates: ['12-24'], from: '14:00' }, 'dates needs from and to as HH:mm'],
      [{ dates: ['12-24'], to: '24:00' }, 'dates needs from and to as HH:mm'],
    ];
    for (const [r, msg] of bad) expect(validateCategoryRule(r), JSON.stringify(r)).toBe(msg);
  });
});

describe('rule profiles (only stricter than the law)', () => {
  it('accepts the defaults, stricter values and boundaries', () => {
    expect(validateLimits({})).toEqual([]);
    expect(validateLimits({ dailyMaxMinutes: 600, dailyWarnMinutes: 480 })).toEqual([]);
    expect(validateLimits({ dailyMaxMinutes: 540, dailyWarnMinutes: 240 })).toEqual([]);
    expect(validateLimits({ restBlockMinutes: 660, restWarnMinutes: 660 })).toEqual([]);
    expect(validateLimits({ restWarnMinutes: 1440, restBlockMinutes: 1440 })).toEqual([]);
    expect(validateLimits({ minorDailyMaxMinutes: 60 })).toEqual([]);
    expect(validateLimits({ sundaysFreeMin: 52 })).toEqual([]);
    expect(validateLimits({ nightWorkerNights: 1 })).toEqual([]);
    expect(validateLimits({ minorRestMinutes: 720 })).toEqual([]);
  });
  it.each([
    [{ dailyMaxMinutes: 601 }, 'dailyMaxMinutes: may not exceed 600'],
    [{ dailyWarnMinutes: 481 }, 'dailyWarnMinutes: may not exceed 480'],
    [{ dailyMaxMinutes: 400, dailyWarnMinutes: 450 }, 'dailyWarnMinutes: may not exceed dailyMaxMinutes'],
    [{ dailyWarnMinutes: 239 }, 'dailyWarnMinutes: at least 240'],
    [{ restBlockMinutes: 599 }, 'restBlockMinutes: at least 600'],
    [{ restWarnMinutes: 659 }, 'restWarnMinutes: at least 660'],
    [{ restBlockMinutes: 700 }, 'restBlockMinutes: may not exceed restWarnMinutes'],
    [{ restWarnMinutes: 1441 }, 'restWarnMinutes: at most 1440'],
    [{ minorRestMinutes: 719 }, 'minorRestMinutes: at least 720'],
    [{ minorDailyMaxMinutes: 481 }, 'minorDailyMaxMinutes: may not exceed 480'],
    [{ minorDailyMaxMinutes: 59 }, 'minorDailyMaxMinutes: at least 60'],
    [{ sundaysFreeMin: 14 }, 'sundaysFreeMin: at least 15'],
    [{ sundaysFreeMin: 53 }, 'sundaysFreeMin: at most 52'],
    [{ nightWorkerNights: 49 }, 'nightWorkerNights: may not exceed 48'],
    [{ nightWorkerNights: 0 }, 'nightWorkerNights: at least 1'],
  ])('rejects %j with "%s"', (limits, message) => expect(validateLimits(limits as never)).toContain(message));
  it('rejects unknown keys and non-integers', () => {
    expect(validateLimits({ nope: 5 } as never)).toEqual(['nope: unknown rule']);
    expect(validateLimits({ dailyMaxMinutes: 500.5 })).toEqual(['dailyMaxMinutes: must be an integer']);
    expect(validateLimits({ dailyMaxMinutes: Number.NaN })).toContain('dailyMaxMinutes: must be an integer');
    expect(validateLimits({ dailyMaxMinutes: Infinity })).toContain('dailyMaxMinutes: must be an integer');
  });
  it('merges over the defaults and tolerates null', () => {
    expect(mergeLimits(null)).toEqual(DEFAULT_LIMITS);
    expect(mergeLimits(undefined)).toEqual(DEFAULT_LIMITS);
    expect(mergeLimits({ dailyMaxMinutes: 540 })).toEqual({ ...DEFAULT_LIMITS, dailyMaxMinutes: 540 });
    expect(DEFAULT_LIMITS).toEqual({
      dailyMaxMinutes: 600,
      dailyWarnMinutes: 480,
      restWarnMinutes: 660,
      restBlockMinutes: 600,
      minorRestMinutes: 720,
      minorDailyMaxMinutes: 480,
      sundaysFreeMin: 15,
      nightWorkerNights: 48,
    });
  });
});

describe('leave rules', () => {
  const base = { days: ['2027-02-08', '2027-02-09'], departmentId: 1, absentOthers: {}, departmentCap: null };
  const bo = (over: Record<string, unknown> = {}) => ({
    id: 7,
    departmentId: null as number | null,
    from: '2027-02-09',
    to: '2027-02-20',
    reason: 'Messe',
    maxConcurrentAbsent: null as number | null,
    ...over,
  });
  it('a blackout covers its first and last day inclusive and lists the affected days', () => {
    const r = absenceLimitIssues({
      ...base,
      days: ['2027-02-08', '2027-02-09', '2027-02-20', '2027-02-21'],
      blackouts: [bo()],
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      code: 'BLACKOUT',
      severity: 'needs_reason',
      details: { blackoutId: 7, reason: 'Messe', dates: ['2027-02-09', '2027-02-20'] },
    });
  });
  it('a blackout of another department is ignored, one without department applies to all', () => {
    expect(absenceLimitIssues({ ...base, blackouts: [bo({ departmentId: 2 })] })).toEqual([]);
    expect(absenceLimitIssues({ ...base, blackouts: [bo({ departmentId: 1 })] })).toHaveLength(1);
  });
  it('a concurrency cap counts the person: the cap is exceeded when others + 1 is above it', () => {
    const cap = (n: number) =>
      absenceLimitIssues({
        ...base,
        blackouts: [bo({ maxConcurrentAbsent: 2 })],
        absentOthers: { '2027-02-09': n },
      });
    expect(cap(1)).toEqual([]);
    const r = cap(2);
    expect(r[0]).toMatchObject({
      code: 'MAX_CONCURRENT',
      details: { blackoutId: 7, reason: 'Messe', max: 2, dates: ['2027-02-09'] },
    });
    expect(absenceLimitIssues({ ...base, blackouts: [bo({ maxConcurrentAbsent: 2 })] })).toEqual([]); // nobody else absent
  });
  it('the department default cap works the same way and is reported once with all days', () => {
    const r = absenceLimitIssues({
      ...base,
      blackouts: [],
      departmentCap: 1,
      absentOthers: { '2027-02-08': 1, '2027-02-09': 3 },
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      code: 'MAX_CONCURRENT',
      details: { max: 1, dates: ['2027-02-08', '2027-02-09'] },
    });
    expect(
      absenceLimitIssues({ ...base, blackouts: [], departmentCap: 2, absentOthers: { '2027-02-08': 1 } }),
    ).toEqual([]);
  });
  it('wishes: a leave wish covers its boundaries, a shift wish for the day is contradicted by another shift', () => {
    const leave = [{ from: '2027-02-09', to: '2027-02-11', priority: 2 }];
    expect(wishConflicts({ localDate: '2027-02-08', shiftId: 1 }, [], leave)).toEqual([]);
    expect(wishConflicts({ localDate: '2027-02-09', shiftId: 1 }, [], leave)[0]).toMatchObject({
      code: 'WISH_CONFLICT',
      severity: 'warn',
      details: { kind: 'leave', date: '2027-02-09', priority: 2 },
    });
    expect(wishConflicts({ localDate: '2027-02-11', shiftId: 1 }, [], leave)).toHaveLength(1);
    expect(wishConflicts({ localDate: '2027-02-12', shiftId: 1 }, [], leave)).toEqual([]);
    const shift = [
      { date: '2027-02-09', shiftId: 3, priority: 2 },
      { date: '2027-02-09', shiftId: 4, priority: 1 },
    ];
    expect(wishConflicts({ localDate: '2027-02-09', shiftId: 3 }, shift, [])).toEqual([]);
    expect(wishConflicts({ localDate: '2027-02-09', shiftId: 4 }, shift, [])).toEqual([]);
    expect(wishConflicts({ localDate: '2027-02-09', shiftId: 5 }, shift, [])[0]).toMatchObject({
      details: { kind: 'shift', priority: 1 },
    });
    expect(wishConflicts({ localDate: '2027-02-10', shiftId: 5 }, shift, [])).toEqual([]);
  });
  const win = (over = {}) => ({
    weekday: 1,
    fromMin: 600,
    toMin: 720,
    kind: 'unavailable' as const,
    validFrom: '2027-02-01',
    validTo: '2027-02-28' as string | null,
    note: null as string | null,
    ...over,
  });
  it('availability: validity boundaries are inclusive, preferred windows never conflict, overlap needs real minutes', () => {
    const e = (date: string, from: number, to: number) => ({
      localDate: date,
      startLocalMin: from,
      endLocalMin: to,
    });
    expect(availabilityConflicts(e('2027-02-08', 660, 900), [win()])).toHaveLength(1); // Monday inside the window
    expect(
      availabilityConflicts(e('2027-02-01', 660, 900), [win({ weekday: 1, validFrom: '2027-02-01' })]),
    ).toHaveLength(1);
    expect(availabilityConflicts(e('2027-02-08', 660, 900), [win({ validFrom: '2027-02-08' })])).toHaveLength(
      1,
    );
    expect(availabilityConflicts(e('2027-02-08', 660, 900), [win({ validFrom: '2027-02-09' })])).toEqual([]);
    expect(availabilityConflicts(e('2027-02-08', 660, 900), [win({ validTo: '2027-02-08' })])).toHaveLength(
      1,
    );
    expect(availabilityConflicts(e('2027-02-08', 660, 900), [win({ validTo: '2027-02-07' })])).toEqual([]);
    expect(availabilityConflicts(e('2027-02-08', 660, 900), [win({ validTo: null })])).toHaveLength(1);
    expect(availabilityConflicts(e('2027-02-08', 720, 900), [win()])).toEqual([]);
    expect(availabilityConflicts(e('2027-02-08', 660, 900), [win({ kind: 'preferred' as never })])).toEqual(
      [],
    );
    expect(availabilityConflicts(e('2027-02-09', 660, 900), [win()])).toEqual([]); // Tuesday
    // an entry past midnight touches the next day (Tuesday 00:00-02:00 unavailable)
    const tue = win({ weekday: 2, fromMin: 0, toMin: 120, note: 'Kurs' });
    expect(availabilityConflicts(e('2027-02-08', 1320, 1500), [tue])[0]).toMatchObject({
      details: { date: '2027-02-09', from: 0, to: 120, note: 'Kurs' },
    });
    expect(availabilityConflicts(e('2027-02-08', 1320, 1440), [tue])).toEqual([]);
    expect(availabilityConflicts(e('2027-02-08', 1320, 1441), [tue])).toHaveLength(1);
    // a window on Sunday and an entry on Sunday (weekday 7)
    expect(availabilityConflicts(e('2027-02-07', 660, 900), [win({ weekday: 7 })])).toHaveLength(1);
    // the part before midnight is clipped at 24:00
    expect(
      availabilityConflicts(e('2027-02-08', 1380, 1500), [win({ weekday: 1, fromMin: 1430, toMin: 1440 })]),
    ).toHaveLength(1);
    expect(
      availabilityConflicts(e('2027-02-08', 1380, 1500), [
        win({ weekday: 1, fromMin: 1440 + 10, toMin: 1440 + 20 }),
      ]),
    ).toEqual([]);
  });
  it('qualifications: held and valid passes; expired or missing warns with the reason', () => {
    expect(qualificationIssue(null, [], '2027-02-08')).toEqual([]);
    expect(qualificationIssue(0, [], '2027-02-08')).toEqual([]);
    expect(qualificationIssue(3, [{ id: 3, validUntil: null }], '2027-02-08')).toEqual([]);
    expect(qualificationIssue(3, [{ id: 3, validUntil: '2027-02-08' }], '2027-02-08')).toEqual([]);
    expect(qualificationIssue(3, [{ id: 4, validUntil: null }], '2027-02-08')[0]).toMatchObject({
      severity: 'warn',
      details: { qualificationId: 3, expired: false, validUntil: null },
    });
    expect(qualificationIssue(3, [{ id: 3, validUntil: '2027-02-07' }], '2027-02-08')[0]).toMatchObject({
      details: { expired: true, validUntil: '2027-02-07' },
    });
  });
});

describe('occupancy rules', () => {
  const rules = [
    { minOccupancyPct: 30, headcount: 2 },
    { minOccupancyPct: 60, headcount: 4 },
    { minOccupancyPct: 60, headcount: 5 },
  ];
  it('uses the highest threshold that is met, the first of equals, and none below the lowest', () => {
    expect(suggestHeadcount(29, rules)).toBeNull();
    expect(suggestHeadcount(30, rules)).toBe(2);
    expect(suggestHeadcount(59, rules)).toBe(2);
    expect(suggestHeadcount(60, rules)).toBe(4);
    expect(suggestHeadcount(100, rules)).toBe(4);
    expect(suggestHeadcount(50, [])).toBeNull();
  });
});
