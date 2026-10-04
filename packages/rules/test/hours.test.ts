import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  categoryMinutes,
  checkEntry,
  isNightWork,
  nightMinutesOf,
  restCompensations,
  sundaysInYear,
  validateCategoryRule,
  validateLimits,
  type CheckInput,
  type HourCategory,
} from '../src';

const cats: HourCategory[] = [
  { code: 'night', rule: { daily: { from: '23:00', to: '06:00' } } },
  { code: 'sunday', rule: { weekday: 7 } },
  { code: 'holiday', rule: { holiday: true } },
  { code: 'eve', rule: { dates: ['12-24', '12-31'], from: '14:00', to: '24:00' } },
];

describe('categoryMinutes', () => {
  it('splits a Saturday night shift over midnight into night and Sunday minutes', () => {
    // Saturday 2026-09-05 22:00 -> Sunday 06:00 (local)
    const m = categoryMinutes(
      [
        { date: '2026-09-05', fromMin: 1320, toMin: 1440 },
        { date: '2026-09-06', fromMin: 0, toMin: 360 },
      ],
      cats,
      new Set(),
    );
    expect(m).toEqual({ night: 60 + 360, sunday: 360 });
  });
  it('counts holiday work and the 24/31 December afternoon window', () => {
    expect(
      categoryMinutes([{ date: '2026-10-03', fromMin: 480, toMin: 960 }], cats, new Set(['2026-10-03'])),
    ).toEqual({ holiday: 480 });
    expect(categoryMinutes([{ date: '2026-12-24', fromMin: 780, toMin: 1080 }], cats, new Set())).toEqual({
      eve: 240,
    });
    expect(categoryMinutes([{ date: '2026-12-23', fromMin: 780, toMin: 1080 }], cats, new Set())).toEqual({});
  });
  it('returns nothing for a plain weekday morning', () => {
    expect(categoryMinutes([{ date: '2026-09-09', fromMin: 360, toMin: 840 }], cats, new Set())).toEqual({});
  });
});

describe('validateCategoryRule', () => {
  it('accepts the four shapes and rejects the rest', () => {
    for (const r of [
      { daily: { from: '22:00', to: '06:00' } },
      { weekday: 6 },
      { holiday: true },
      { dates: ['05-01'], from: '00:00', to: '24:00' },
    ])
      expect(validateCategoryRule(r)).toBeNull();
    for (const r of [
      null,
      {},
      { weekday: 8 },
      { holiday: false },
      { daily: { from: '25:00', to: '06:00' } },
      { dates: ['13-01'], from: '10:00', to: '12:00' },
      { weekday: 1, holiday: true },
    ])
      expect(validateCategoryRule(r)).not.toBeNull();
  });
});

describe('restCompensations', () => {
  const H = 3600000;
  const day = 24 * H;
  const t0 = Date.UTC(2027, 0, 4, 6); // Monday 06:00
  const shift = (d: number, from: number, to: number) => ({
    startMs: t0 + d * day + (from - 6) * H,
    endMs: t0 + d * day + (to - 6) * H,
  });
  it('lists a 10.5 h rest and finds the compensating 12 h rest within four weeks', () => {
    // day 0 until 22:00, next day starts 08:30 (10.5 h), then a long break before day 3
    const s = [shift(0, 14, 22), shift(1, 8.5, 16), shift(3, 8, 16)];
    const r = restCompensations(s, t0 + 10 * day);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ gapMinutes: 630, status: 'ok' });
  });
  it('is open before the due date and overdue after it when no 12 h rest follows', () => {
    const s = [
      shift(0, 14, 22),
      shift(1, 8.5, 16),
      shift(2, 6, 14).startMs
        ? { startMs: shift(1, 8.5, 16).endMs + 11 * H, endMs: shift(1, 8.5, 16).endMs + 19 * H }
        : shift(2, 6, 14),
    ];
    expect(restCompensations(s, t0 + 7 * day)[0]!.status).toBe('open');
    expect(restCompensations(s, t0 + 40 * day)[0]!.status).toBe('overdue');
  });
  it('ignores normal (>= 11 h) and blocked (< 10 h) rests', () => {
    expect(restCompensations([shift(0, 14, 22), shift(1, 9, 17)], 0)).toEqual([]);
    expect(restCompensations([shift(0, 14, 22), shift(1, 7, 15)], 0)).toEqual([]);
  });
});

describe('validateLimits', () => {
  it('allows stricter values only', () => {
    expect(validateLimits({ dailyMaxMinutes: 540, restWarnMinutes: 720, sundaysFreeMin: 20 })).toEqual([]);
    expect(validateLimits({ dailyMaxMinutes: 660 }).join()).toMatch(/dailyMaxMinutes/);
    expect(validateLimits({ restWarnMinutes: 600 }).join()).toMatch(/restWarnMinutes/);
    expect(validateLimits({ minorRestMinutes: 600 }).join()).toMatch(/minorRestMinutes/);
    expect(validateLimits({ sundaysFreeMin: 10 }).join()).toMatch(/sundaysFreeMin/);
    expect(validateLimits({ dailyWarnMinutes: 600, dailyMaxMinutes: 540 }).join()).toMatch(
      /dailyWarnMinutes/,
    );
    expect(validateLimits({ foo: 1 } as any).join()).toMatch(/unknown/);
  });
});

describe('Sunday and night work', () => {
  it('counts Sundays and recognises night work of at least two hours', () => {
    expect(sundaysInYear(2027)).toBe(52);
    expect(sundaysInYear(2026)).toBe(52);
    expect(nightMinutesOf(1320, 1800)).toBe(420);
    expect(isNightWork(1320, 1800)).toBe(true);
    expect(isNightWork(360, 840)).toBe(false);
    expect(isNightWork(1320, 1500)).toBe(true); // 23:00-01:00 is exactly 2 h
    expect(isNightWork(1320, 1470)).toBe(false); // only 90 minutes
  });

  const base = (localDate: string, startLocalMin: number, endLocalMin: number): CheckInput => ({
    entry: {
      hotelId: 1,
      departmentId: 1,
      startMs: 0,
      endMs: (endLocalMin - startLocalMin) * 60000,
      breakMinutes: 0,
      localDate,
      startLocalMin,
      endLocalMin,
    },
    employee: { dateOfBirth: '1990-01-01', active: true, hotelIds: [1], departmentIds: [1] },
    contractActive: true,
    monthlyHoursCap: null,
    others: [],
    absenceOnDay: false,
    periodClosed: false,
    today: '2026-01-01',
  });
  it('warns when fewer Sundays than required stay free', () => {
    const sundays = Array.from({ length: 37 }, (_, i) =>
      new Date(Date.UTC(2027, 0, 3 + 7 * i)).toISOString().slice(0, 10),
    );
    const ok = checkEntry({
      ...base('2027-09-12', 480, 960),
      calendar: { sundayDates: sundays.slice(0, 36), nightDates: [] },
    });
    expect(ok.map((v) => v.code)).not.toContain('SUNDAY_LIMIT');
    const warn = checkEntry({
      ...base('2027-10-10', 480, 960),
      calendar: { sundayDates: sundays, nightDates: [] },
    });
    expect(warn.find((v) => v.code === 'SUNDAY_LIMIT')).toMatchObject({
      severity: 'warn',
      details: { freeSundays: 14, required: 15 },
    });
  });
  it('flags a night worker from 48 nights and honours stricter profile limits', () => {
    const nights = Array.from({ length: 47 }, (_, i) =>
      new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10),
    );
    expect(
      checkEntry({
        ...base('2026-09-01', 1320, 1800),
        calendar: { sundayDates: [], nightDates: nights },
      }).map((v) => v.code),
    ).toContain('NIGHT_WORKER');
    expect(
      checkEntry({
        ...base('2026-09-01', 1320, 1800),
        calendar: { sundayDates: [], nightDates: nights.slice(0, 40) },
      }).map((v) => v.code),
    ).not.toContain('NIGHT_WORKER');
    expect(
      checkEntry({
        ...base('2026-09-01', 1320, 1800),
        limits: { nightWorkerNights: 5 },
        calendar: { sundayDates: [], nightDates: nights.slice(0, 4) },
      }).map((v) => v.code),
    ).toContain('NIGHT_WORKER');
  });
  it('applies profile limits to the daily maximum and rest period', () => {
    const e = base('2027-03-02', 360, 960); // 10 h gross, 0 break
    expect(checkEntry(e).map((v) => v.code)).toContain('DAILY_OVER_8H');
    expect(checkEntry(e).map((v) => v.code)).not.toContain('DAILY_LIMIT');
    expect(
      checkEntry({ ...e, limits: { dailyMaxMinutes: 540 } }).find((v) => v.code === 'DAILY_LIMIT')?.severity,
    ).toBe('block');
    expect(DEFAULT_LIMITS.dailyMaxMinutes).toBe(600);
  });
});
