import { describe, expect, it } from 'vitest';
import { aggregate, checkEntry, validOverrideReason, type CheckInput, type RuleOther } from '../src';

const H = 3600e3;
const base = Date.parse('2026-10-12T00:00:00+02:00');
const at = (day: number, hour: number) => base + day * 24 * H + hour * H;
const date = (day: number) => `2026-10-${String(12 + day).padStart(2, '0')}`;

function input(over: Partial<CheckInput['entry']> = {}, extra: Partial<CheckInput> = {}): CheckInput {
  return {
    entry: {
      id: null,
      hotelId: 1,
      departmentId: 10,
      startMs: at(1, 6),
      endMs: at(1, 14),
      breakMinutes: 30,
      localDate: date(1),
      startLocalMin: 360,
      endLocalMin: 840,
      ...over,
    },
    employee: {
      dateOfBirth: '1990-01-01',
      active: true,
      hotelIds: [1],
      departmentIds: [10],
      ...(extra.employee ?? {}),
    },
    contractActive: true,
    monthlyHoursCap: null,
    others: [],
    absenceOnDay: false,
    periodClosed: false,
    today: '2026-10-04',
    ...extra,
  };
}
const other = (day: number, from: number, to: number, id = 1): RuleOther => ({
  id,
  startMs: at(day, from),
  endMs: at(day, to),
  breakMinutes: 30,
  localDate: date(day),
});
const codes = (i: CheckInput) => checkEntry(i).map((x) => `${x.code}:${x.severity}`);

describe('checkEntry', () => {
  it('a plain shift is clean', () => expect(codes(input())).toEqual([]));

  it('OVERLAP across entries, split shifts on the same day are allowed', () => {
    expect(codes(input({}, { others: [other(1, 10, 18)] }))).toContain('OVERLAP:block');
    // breakfast 06-10 + dinner 17-21 on the same day: no overlap and no rest period problem
    const split = input(
      { startMs: at(1, 17), endMs: at(1, 21), startLocalMin: 1020, endLocalMin: 1260 },
      { others: [other(1, 6, 10)] },
    );
    expect(codes(split)).toEqual([]);
  });

  it('PAST_DAY, PERIOD_CLOSED, NOT_AT_HOTEL, WRONG_DEPARTMENT, ABSENCE_CONFLICT, CONTRACT_INACTIVE', () => {
    expect(codes(input({}, { today: '2026-10-14' }))).toContain('PAST_DAY:block');
    expect(codes(input({}, { periodClosed: true }))).toContain('PERIOD_CLOSED:block');
    expect(codes(input({ hotelId: 2 }))).toContain('NOT_AT_HOTEL:block');
    expect(codes(input({ departmentId: 11 }))).toContain('WRONG_DEPARTMENT:block');
    expect(codes(input({ departmentId: null }))).not.toContain('WRONG_DEPARTMENT:block');
    expect(codes(input({}, { absenceOnDay: true }))).toContain('ABSENCE_CONFLICT:block');
    expect(codes(input({}, { contractActive: false }))).toContain('CONTRACT_INACTIVE:block');
    expect(
      codes(
        input(
          {},
          { employee: { dateOfBirth: '1990-01-01', active: false, hotelIds: [1], departmentIds: [10] } },
        ),
      ),
    ).toContain('CONTRACT_INACTIVE:block');
  });

  it('daily limit: 8 h ok, over 8 h warns, over 10 h blocks', () => {
    // 06:00-14:00 minus 30 min = 7.5 h
    expect(codes(input())).toEqual([]);
    expect(codes(input({ endMs: at(1, 15), endLocalMin: 900 }))).toEqual(['DAILY_OVER_8H:warn']); // 8.5 h
    expect(codes(input({ endMs: at(1, 17), endLocalMin: 1020 }))).toContain('DAILY_LIMIT:block'); // 10.5 h
    // all entries of the day count
    expect(
      codes(
        input(
          { startMs: at(1, 14), endMs: at(1, 16), startLocalMin: 840, endLocalMin: 960 },
          { others: [other(1, 6, 14)] },
        ),
      ),
    ).toContain('DAILY_OVER_8H:warn');
  });

  it('rest period: < 10 h blocks, 10-11 h needs a reason, >= 11 h ok (both neighbours)', () => {
    const prev = (gapH: number) => other(0, 8, 24 - gapH + 0); // ends gapH before 06:00 next day... built below
    void prev;
    // previous entry ends at day0 22:00 -> gap to 06:00 on day1 = 8 h
    expect(codes(input({}, { others: [other(0, 14, 22)] }))).toEqual(['REST_PERIOD:block']);
    // ends 20:00 -> 10 h
    expect(codes(input({}, { others: [other(0, 12, 20)] }))).toEqual(['REST_PERIOD:needs_reason']);
    // ends 19:00 -> 11 h
    expect(codes(input({}, { others: [other(0, 11, 19)] }))).toEqual([]);
    // next entry starts 8 h after the end (14:00 -> 22:00)
    expect(codes(input({}, { others: [other(1, 22, 23)] }))).toEqual([]); // same day: split shift, no rest check
    expect(codes(input({}, { others: [{ ...other(2, 22, 23), localDate: date(1 + 1) }] }))).toEqual([]);
    expect(
      codes(
        input(
          {},
          { others: [{ id: 3, startMs: at(1, 22), endMs: at(2, 6), breakMinutes: 30, localDate: date(2) }] },
        ),
      ),
    ).toEqual(['REST_PERIOD:block']);
  });

  it('minors: night window, 8 h day, 12 h rest', () => {
    const minor = { dateOfBirth: '2009-02-14', active: true, hotelIds: [1], departmentIds: [10] };
    const night = input(
      { startMs: at(1, 18), endMs: at(1, 21), startLocalMin: 1080, endLocalMin: 1260 },
      { employee: minor },
    );
    expect(codes(night)).toContain('MINOR_NIGHT:block');
    expect(codes(input({}, { employee: { ...minor, dateOfBirth: '2008-10-01' } }))).toEqual([]); // 18 on shift day
    expect(codes(input({ endMs: at(1, 16), endLocalMin: 960 }, { employee: minor }))).toContain(
      'MINOR_DAILY:block',
    ); // 9.5 h
    // 11 h rest: fine for adults, blocked for a 17-year-old
    const rest11 = [other(0, 11, 19)];
    expect(codes(input({}, { others: rest11 }))).toEqual([]);
    expect(codes(input({}, { others: rest11, employee: minor }))).toEqual(['MINOR_REST:block']);
    // 8 h rest: both rules fire for a minor
    expect(codes(input({}, { others: [other(0, 14, 22)], employee: minor }))).toEqual([
      'REST_PERIOD:block',
      'MINOR_REST:block',
    ]);
  });

  it('monthly cap is a warning', () => {
    const i = input({}, { monthlyHoursCap: 7, others: [] });
    expect(codes(i)).toEqual(['MONTHLY_CAP:warn']); // 7.5 h > 7
    expect(codes(input({}, { monthlyHoursCap: 8 }))).toEqual([]);
    // entries in other months do not count
    const o = { ...other(0, 8, 16), localDate: '2026-09-30' };
    expect(codes(input({}, { monthlyHoursCap: 10, others: [o] }))).toEqual([]);
  });

  it('skip removes codes', () => {
    expect(codes(input({}, { today: '2026-10-14', skip: ['PAST_DAY'] }))).toEqual([]);
  });
});

describe('aggregate', () => {
  const rest = checkEntry(input({}, { others: [other(0, 14, 22)] }));
  const reasonOnly = checkEntry(input({}, { others: [other(0, 12, 20)] }));
  it('blocked beats needs_reason beats ok', () => {
    expect(aggregate([], { role: 'manager' }).status).toBe('ok');
    expect(aggregate(reasonOnly, { role: 'manager' }).status).toBe('needs_reason');
    expect(aggregate(rest, { role: 'manager' }).status).toBe('blocked');
  });
  it('emergency override: only admin / super admin, only the overridable codes', () => {
    expect(aggregate(rest, { role: 'manager', emergencyOverride: true }).status).toBe('blocked');
    const a = aggregate(rest, { role: 'admin', emergencyOverride: true });
    expect(a.status).toBe('needs_reason');
    expect(a.overridden).toEqual(['REST_PERIOD']);
    expect(aggregate(rest, { role: 'superAdmin', emergencyOverride: true }).status).toBe('needs_reason');
    // a block that is not overridable stays
    const overlap = checkEntry(input({}, { others: [other(1, 10, 18)] }));
    expect(aggregate(overlap, { role: 'admin', emergencyOverride: true }).status).toBe('blocked');
    const minorNight = checkEntry(
      input(
        { startMs: at(1, 18), endMs: at(1, 21), startLocalMin: 1080, endLocalMin: 1260 },
        { employee: { dateOfBirth: '2009-02-14', active: true, hotelIds: [1], departmentIds: [10] } },
      ),
    );
    expect(aggregate(minorNight, { role: 'admin', emergencyOverride: true }).status).toBe('blocked');
  });
  it('override reason is 5-300 characters', () => {
    expect(validOverrideReason('abcd')).toBe(false);
    expect(validOverrideReason('abcde')).toBe(true);
    expect(validOverrideReason('x'.repeat(301))).toBe(false);
    expect(validOverrideReason(null)).toBe(false);
  });
});
