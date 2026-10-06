import { describe, expect, it } from 'vitest';
import {
  aggregate,
  applySeverities,
  checkEntry,
  effectiveSeverities,
  LOCKED_CODES,
  RESTRICTIONS,
  validateSeverities,
  type CheckInput,
  type RuleOther,
  type Violation,
} from '../src';

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
    employee: { dateOfBirth: '1990-01-01', active: true, hotelIds: [1], departmentIds: [10] },
    contractActive: true,
    monthlyHoursCap: null,
    others: [],
    absenceOnDay: false,
    periodClosed: false,
    today: '2026-10-04',
    ...extra,
  };
}
const other = (day: number, from: number, to: number): RuleOther => ({
  id: 1,
  startMs: at(day, from),
  endMs: at(day, to),
  breakMinutes: 30,
  localDate: date(day),
});
const codes = (i: CheckInput) => checkEntry(i).map((x) => `${x.code}:${x.severity}`);
const viol = (
  code: string,
  severity: Violation['severity'],
  details: Record<string, unknown> = {},
): Violation => ({
  code,
  severity,
  message: 'm',
  details,
});

describe('the catalogue', () => {
  it('lists exactly the configurable restrictions with their levels and defaults', () => {
    expect(RESTRICTIONS.map((r) => [r.code, [...r.levels], r.default])).toEqual([
      ['DAILY_OVER_8H', ['soft', 'hard'], 'soft'],
      ['REST_PERIOD_SHORT', ['reason', 'hard'], 'reason'],
      ['MONTHLY_CAP', ['soft', 'hard'], 'soft'],
      ['SUNDAY_LIMIT', ['soft', 'hard'], 'soft'],
      ['NIGHT_WORKER', ['soft', 'hard'], 'soft'],
      ['ABSENCE_CONFLICT', ['soft', 'hard'], 'hard'],
      ['WRONG_DEPARTMENT', ['soft', 'hard'], 'hard'],
      ['UNAVAILABLE', ['soft', 'reason', 'hard'], 'reason'],
      ['WISH_CONFLICT', ['soft', 'hard'], 'soft'],
      ['QUALIFICATION_MISSING', ['soft', 'hard'], 'soft'],
    ]);
  });

  it('every default is one of the offered levels, and statutory limits are never configurable', () => {
    for (const r of RESTRICTIONS) expect(r.levels).toContain(r.default);
    expect(new Set(RESTRICTIONS.map((r) => r.code)).size).toBe(RESTRICTIONS.length);
    for (const c of LOCKED_CODES) expect(RESTRICTIONS.some((r) => r.code === c)).toBe(false);
    expect([...LOCKED_CODES].sort()).toEqual(
      [
        'CONTRACT_INACTIVE',
        'DAILY_LIMIT',
        'MINOR_DAILY',
        'MINOR_NIGHT',
        'MINOR_REST',
        'NOT_AT_HOTEL',
        'OVERLAP',
        'PAST_DAY',
        'PERIOD_CLOSED',
        'REST_PERIOD',
      ].sort(),
    );
  });
});

describe('validateSeverities', () => {
  it('accepts an empty and every allowed configuration', () => {
    expect(validateSeverities({})).toEqual([]);
    expect(
      validateSeverities({ DAILY_OVER_8H: 'hard', UNAVAILABLE: 'soft', REST_PERIOD_SHORT: 'reason' }),
    ).toEqual([]);
    for (const r of RESTRICTIONS)
      for (const l of r.levels) expect(validateSeverities({ [r.code]: l })).toEqual([]);
  });

  it('names every problem: unknown restrictions, locked ones and levels that are not offered', () => {
    expect(validateSeverities({ NOPE: 'hard' })).toEqual(['NOPE: unknown restriction']);
    expect(validateSeverities({ DAILY_LIMIT: 'soft' })).toEqual([
      'DAILY_LIMIT: statutory or technical, always hard',
    ]);
    expect(validateSeverities({ OVERLAP: 'hard' })).toEqual(['OVERLAP: statutory or technical, always hard']);
    expect(validateSeverities({ DAILY_OVER_8H: 'reason' })).toEqual([
      'DAILY_OVER_8H: must be one of soft, hard',
    ]);
    // the statutory part of the rest period cannot be turned into a plain warning
    expect(validateSeverities({ REST_PERIOD_SHORT: 'soft' })).toEqual([
      'REST_PERIOD_SHORT: must be one of reason, hard',
    ]);
    expect(validateSeverities({ ABSENCE_CONFLICT: 'maybe' })).toEqual([
      'ABSENCE_CONFLICT: must be one of soft, hard',
    ]);
    expect(validateSeverities({ ABSENCE_CONFLICT: 3 })).toHaveLength(1);
    expect(validateSeverities({ NOPE: 'x', DAILY_LIMIT: 'soft', MONTHLY_CAP: 'reason' })).toHaveLength(3);
  });
});

describe('effectiveSeverities', () => {
  it('is the defaults without configuration, for undefined and null as well', () => {
    const d = Object.fromEntries(RESTRICTIONS.map((r) => [r.code, r.default]));
    expect(effectiveSeverities()).toEqual(d);
    expect(effectiveSeverities(null)).toEqual(d);
    expect(effectiveSeverities({})).toEqual(d);
  });

  it('puts the configuration on top and ignores levels that are not offered or unknown restrictions', () => {
    const e = effectiveSeverities({
      DAILY_OVER_8H: 'hard',
      ABSENCE_CONFLICT: 'soft',
      REST_PERIOD_SHORT: 'soft',
      X: 'hard',
    });
    expect(e.DAILY_OVER_8H).toBe('hard');
    expect(e.ABSENCE_CONFLICT).toBe('soft');
    expect(e.REST_PERIOD_SHORT).toBe('reason');
    expect(e.MONTHLY_CAP).toBe('soft');
    expect(Object.keys(e)).toHaveLength(RESTRICTIONS.length);
    expect(e).not.toHaveProperty('X');
  });
});

describe('applySeverities', () => {
  it('returns the same list without configuration', () => {
    const list = [viol('DAILY_OVER_8H', 'warn')];
    expect(applySeverities(list)).toBe(list);
    expect(applySeverities(list, null)).toBe(list);
  });

  it('soft is a warning, reason needs a reason, hard blocks and is marked against the emergency override', () => {
    const [soft] = applySeverities([viol('ABSENCE_CONFLICT', 'block', { date: 'd' })], {
      ABSENCE_CONFLICT: 'soft',
    });
    expect(soft.severity).toBe('warn');
    expect(soft.details).toEqual({ date: 'd' });
    const [reason] = applySeverities([viol('UNAVAILABLE', 'needs_reason')], { UNAVAILABLE: 'reason' });
    expect(reason.severity).toBe('needs_reason');
    expect(reason.details).toEqual({});
    const [hard] = applySeverities([viol('MONTHLY_CAP', 'warn', { cap: 20 })], { MONTHLY_CAP: 'hard' });
    expect(hard.severity).toBe('block');
    expect(hard.details).toEqual({ cap: 20, configuredHard: true });
    const [unavail] = applySeverities([viol('UNAVAILABLE', 'needs_reason')], { UNAVAILABLE: 'soft' });
    expect(unavail.severity).toBe('warn');
  });

  it('every configurable restriction follows its configured level', () => {
    for (const r of RESTRICTIONS) {
      const code = r.code === 'REST_PERIOD_SHORT' ? 'REST_PERIOD' : r.code;
      const sev: Violation['severity'] = r.code === 'REST_PERIOD_SHORT' ? 'needs_reason' : 'warn';
      for (const l of r.levels) {
        const [x] = applySeverities([viol(code, sev)], { [r.code]: l });
        expect(x.severity).toBe(l === 'soft' ? 'warn' : l === 'reason' ? 'needs_reason' : 'block');
      }
    }
  });

  it('leaves unconfigured, unknown and locked codes alone', () => {
    const v1 = viol('MONTHLY_CAP', 'warn');
    const v2 = viol('SOMETHING_ELSE', 'warn');
    const v3 = viol('DAILY_LIMIT', 'block');
    const out = applySeverities([v1, v2, v3], {
      DAILY_OVER_8H: 'hard',
      SOMETHING_ELSE: 'hard',
      DAILY_LIMIT: 'soft',
    });
    expect(out).toEqual([v1, v2, v3]);
  });

  it('ignores a configured level that the restriction does not offer', () => {
    const [x] = applySeverities([viol('REST_PERIOD', 'needs_reason')], { REST_PERIOD_SHORT: 'soft' });
    expect(x.severity).toBe('needs_reason');
    const [y] = applySeverities([viol('DAILY_OVER_8H', 'warn')], { DAILY_OVER_8H: 'reason' });
    expect(y.severity).toBe('warn');
  });

  it('only the short band of the rest period is configurable, below 10 hours stays blocked', () => {
    const cfg = { REST_PERIOD_SHORT: 'hard' as const };
    const [short] = applySeverities([viol('REST_PERIOD', 'needs_reason', { gapMinutes: 630 })], cfg);
    expect(short.severity).toBe('block');
    expect(short.details).toEqual({ gapMinutes: 630, configuredHard: true });
    const statutory = viol('REST_PERIOD', 'block', { gapMinutes: 500 });
    const [low] = applySeverities([statutory], cfg);
    expect(low).toBe(statutory);
    expect(low.details).not.toHaveProperty('configuredHard');
  });
});

describe('checkEntry with configured severities', () => {
  const long = input({ startMs: at(1, 6), endMs: at(1, 16), endLocalMin: 960 }); // 9.5 h of work

  it("keeps today's behaviour when nothing is configured", () => {
    expect(codes(long)).toEqual(['DAILY_OVER_8H:warn']);
    expect(codes({ ...long, severities: {} })).toEqual(['DAILY_OVER_8H:warn']);
    expect(codes(input({}, { absenceOnDay: true }))).toEqual(['ABSENCE_CONFLICT:block']);
  });

  it('hard turns a warning into a block', () => {
    const c = { ...long, severities: { DAILY_OVER_8H: 'hard' as const } };
    expect(codes(c)).toEqual(['DAILY_OVER_8H:block']);
    expect(aggregate(checkEntry(c), { role: 'admin' }).status).toBe('blocked');
    expect(aggregate(checkEntry(long), { role: 'admin' }).status).toBe('ok');
  });

  it('soft turns a block into a warning: absence and department can then be planned', () => {
    const absent = input({}, { absenceOnDay: true, severities: { ABSENCE_CONFLICT: 'soft' } });
    expect(codes(absent)).toEqual(['ABSENCE_CONFLICT:warn']);
    expect(aggregate(checkEntry(absent), { role: 'manager' }).status).toBe('ok');
    const wrongDept = input({ departmentId: 99 }, { severities: { WRONG_DEPARTMENT: 'soft' } });
    expect(codes(wrongDept)).toEqual(['WRONG_DEPARTMENT:warn']);
    expect(aggregate(checkEntry(wrongDept), { role: 'manager' }).status).toBe('ok');
  });

  it('a monthly cap can be made hard', () => {
    const c = input({}, { monthlyHoursCap: 4, severities: { MONTHLY_CAP: 'hard' } });
    expect(codes(c)).toEqual(['MONTHLY_CAP:block']);
  });

  it('statutory and technical restrictions cannot be softened', () => {
    const cfg = { DAILY_LIMIT: 'soft', OVERLAP: 'soft', REST_PERIOD: 'soft', PAST_DAY: 'soft' } as never;
    const tooLong = input({ endMs: at(1, 19), endLocalMin: 1140 }, { severities: cfg });
    expect(codes(tooLong)).toEqual(['DAILY_LIMIT:block']);
    expect(codes(input({}, { others: [other(1, 10, 18)], severities: cfg }))).toContain('OVERLAP:block');
    expect(codes(input({}, { others: [other(0, 12, 22)], severities: cfg }))).toContain('REST_PERIOD:block');
    expect(codes(input({}, { today: '2026-10-20', severities: cfg }))).toContain('PAST_DAY:block');
  });

  describe('rest period between 10 and 11 hours', () => {
    const near = input({}, { others: [other(0, 12, 19.5)] }); // 19:30 -> 06:00 next day = 10.5 h
    it('needs a reason by default, can be made hard', () => {
      expect(codes(near)).toEqual(['REST_PERIOD:needs_reason']);
      expect(aggregate(checkEntry(near), { role: 'manager' }).status).toBe('needs_reason');
      const hard = { ...near, severities: { REST_PERIOD_SHORT: 'hard' as const } };
      expect(codes(hard)).toEqual(['REST_PERIOD:block']);
      expect(aggregate(checkEntry(hard), { role: 'manager' }).status).toBe('blocked');
    });

    it('a restriction set to hard is outside the emergency override, the statutory block stays overridable', () => {
      const hard = { ...near, severities: { REST_PERIOD_SHORT: 'hard' as const } };
      const withOverride = aggregate(checkEntry(hard), { role: 'admin', emergencyOverride: true });
      expect(withOverride.status).toBe('blocked');
      expect(withOverride.overridden).toEqual([]);
      const below = input({}, { others: [other(0, 12, 22)] }); // 8 h of rest
      const done = aggregate(checkEntry(below), { role: 'admin', emergencyOverride: true });
      expect(done.status).toBe('needs_reason');
      expect(done.overridden).toEqual(['REST_PERIOD']);
    });
  });
});
