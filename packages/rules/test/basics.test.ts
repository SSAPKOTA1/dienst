import { describe, expect, it } from 'vitest';
import {
  addDays,
  countedDays,
  displayName,
  durationMinutes,
  eachDay,
  isoWeekday,
  mondayOf,
  nextUsername,
  openSlots,
  paidHours,
  proratedVacationDays,
  requiredBreakMinutes,
  resolveRequired,
  sickBackdateAllowed,
  timeAccountBalance,
  usernameBase,
  variationMinutes,
  withinGrace,
} from '../src';

describe('breaks (ArbZG §4, net-time logic)', () => {
  it.each([
    [0, 0],
    [360, 0],
    [361, 1],
    [375, 15],
    [390, 30],
    [391, 30],
    [570, 30],
    [571, 45],
    [900, 45],
  ])('gross %i min needs a break of %i min', (gross, brk) => expect(requiredBreakMinutes(gross)).toBe(brk));
  it('paid hours round to two decimals', () => {
    expect(paidHours(510, 30)).toBe(8);
    expect(paidHours(500, 33)).toBe(7.78);
    expect(paidHours(0, 0)).toBe(0);
  });
});

describe('punch variation and grace', () => {
  it('counts whole minutes, positive when late, truncating towards zero', () => {
    expect(variationMinutes('2026-10-05T06:07:00Z', '2026-10-05T06:00:00Z')).toBe(7);
    expect(variationMinutes('2026-10-05T05:53:00Z', '2026-10-05T06:00:00Z')).toBe(-7);
    expect(variationMinutes('2026-10-05T06:00:59Z', '2026-10-05T06:00:00Z')).toBe(0);
    expect(variationMinutes('2026-10-05T05:59:01Z', '2026-10-05T06:00:00Z') + 0).toBe(0);
    expect(variationMinutes('2026-10-05T06:01:30Z', '2026-10-05T06:00:00Z')).toBe(1);
  });
  it('grace is inclusive and symmetric, default 15 minutes', () => {
    expect(withinGrace(15)).toBe(true);
    expect(withinGrace(-15)).toBe(true);
    expect(withinGrace(16)).toBe(false);
    expect(withinGrace(-16)).toBe(false);
    expect(withinGrace(0)).toBe(true);
    expect(withinGrace(5, 4)).toBe(false);
    expect(withinGrace(4, 4)).toBe(true);
  });
  it('durationMinutes is signed', () => {
    expect(durationMinutes('2026-10-05T08:00:00Z', '2026-10-05T10:30:00Z')).toBe(150);
    expect(durationMinutes('2026-10-05T10:30:00Z', '2026-10-05T08:00:00Z')).toBe(-150);
  });
});

describe('vacation proration (BUrlG: full entitlement after the waiting period within the year)', () => {
  it.each([
    ['2025-12-31', 24], // started in an earlier year
    ['2026-01-01', 24],
    ['2026-06-30', 24],
    ['2026-07-01', 24], // 1 July counts as completed waiting period
    ['2026-07-02', 10], // 5 full months (Aug to Dec) of 24 days
    ['2026-08-01', 10], // starting on the 1st: the month counts
    ['2026-08-02', 8],
    ['2026-11-01', 4],
    ['2026-12-01', 2],
    ['2026-12-02', 0],
    ['2027-01-01', 0], // starts after the year
  ])('start %s with 24 days a year gives %i days', (start, days) =>
    expect(proratedVacationDays(24, start, 2026)).toBe(days),
  );
  it('rounds half up', () => {
    expect(proratedVacationDays(30, '2026-08-01', 2026)).toBe(13); // 12.5
    expect(proratedVacationDays(25, '2026-08-01', 2026)).toBe(10); // 10.4
    expect(proratedVacationDays(29, '2026-08-01', 2026)).toBe(12); // 12.08
    expect(proratedVacationDays(26, '2026-08-01', 2026)).toBe(11); // 10.83
  });
});

describe('names and usernames', () => {
  it('shortens the display name to first name and initial', () => {
    expect(displayName('Maria', 'Schmidt')).toBe('Maria S.');
    expect(displayName('Ömer', 'Kaya')).toBe('Ömer K.');
  });
  it('builds ASCII usernames with German transliteration and without accents', () => {
    expect(usernameBase('Jürgen', 'Müller')).toBe('juergen.mueller');
    expect(usernameBase('Käthe', 'Größe')).toBe('kaethe.groesse');
    expect(usernameBase('Ömer', 'Weiß')).toBe('oemer.weiss');
    expect(usernameBase('José', 'Çelik')).toBe('jose.celik');
    expect(usernameBase('Anne-Marie', "O'Brien")).toBe('annemarie.obrien');
    expect(usernameBase('MARIA', 'SCHMIDT')).toBe('maria.schmidt');
    expect(usernameBase('', '')).toBe('.');
  });
  it('numbers duplicates from 2 on', () => {
    expect(nextUsername('maria.schmidt', new Set())).toBe('maria.schmidt');
    expect(nextUsername('maria.schmidt', new Set(['maria.schmidt']))).toBe('maria.schmidt2');
    expect(
      nextUsername('maria.schmidt', new Set(['maria.schmidt', 'maria.schmidt2', 'maria.schmidt3'])),
    ).toBe('maria.schmidt4');
    expect(nextUsername('x', new Set(['x2']))).toBe('x');
  });
});

describe('open slots and required headcount', () => {
  it('open slots never go below zero', () => {
    expect(openSlots(5, 3)).toBe(2);
    expect(openSlots(3, 5)).toBe(0);
    expect(openSlots(0, 0)).toBe(0);
    expect(openSlots(4, 4)).toBe(0);
  });
  it('a date override beats the weekday default, which beats zero', () => {
    const defaults = { 1: 3, 6: 5 };
    expect(resolveRequired('2026-10-05', defaults, {})).toBe(3); // Monday
    expect(resolveRequired('2026-10-10', defaults, {})).toBe(5); // Saturday
    expect(resolveRequired('2026-10-06', defaults, {})).toBe(0); // Tuesday
    expect(resolveRequired('2026-10-05', defaults, { '2026-10-05': 0 })).toBe(0);
    expect(resolveRequired('2026-10-05', defaults, { '2026-10-05': 7 })).toBe(7);
    expect(resolveRequired('2026-10-05', new Map([[1, 4]]), new Map([['2026-10-06', 2]]))).toBe(4);
    expect(resolveRequired('2026-10-06', new Map([[1, 4]]), new Map([['2026-10-06', 2]]))).toBe(2);
    expect(resolveRequired('2026-10-07', new Map(), new Map())).toBe(0);
  });
});

describe('sickness back-dating', () => {
  it('allows the day itself and up to the limit back, never beyond; future days are fine', () => {
    expect(sickBackdateAllowed('2026-10-10', '2026-10-10')).toBe(true);
    expect(sickBackdateAllowed('2026-10-10', '2026-10-03')).toBe(true); // 7 days
    expect(sickBackdateAllowed('2026-10-10', '2026-10-02')).toBe(false); // 8 days
    expect(sickBackdateAllowed('2026-10-10', '2026-10-12')).toBe(true);
    expect(sickBackdateAllowed('2026-10-10', '2026-10-08', 2)).toBe(true);
    expect(sickBackdateAllowed('2026-10-10', '2026-10-07', 2)).toBe(false);
  });
});

describe('date helpers', () => {
  it('adds days across months, years and leap days', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-10-05', 0)).toBe('2026-10-05');
  });
  it('knows the ISO weekday with Sunday as 7', () => {
    expect(isoWeekday('2026-10-05')).toBe(1);
    expect(isoWeekday('2026-10-10')).toBe(6);
    expect(isoWeekday('2026-10-11')).toBe(7);
  });
  it('finds the Monday of a week', () => {
    expect(mondayOf('2026-10-05')).toBe('2026-10-05');
    expect(mondayOf('2026-10-11')).toBe('2026-10-05');
    expect(mondayOf('2026-10-12')).toBe('2026-10-12');
  });
  it('lists days inclusively and nothing for a reversed range', () => {
    expect(eachDay('2026-10-05', '2026-10-07')).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
    expect(eachDay('2026-10-05', '2026-10-05')).toEqual(['2026-10-05']);
    expect(eachDay('2026-10-06', '2026-10-05')).toEqual([]);
  });
  it('counts only working weekdays that are no public holiday', () => {
    const week = ['2026-10-05', '2026-10-11'] as const;
    expect(countedDays(week[0], week[1], [1, 2, 3, 4, 5], new Set(['2026-10-07']))).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-08',
      '2026-10-09',
    ]);
    expect(countedDays(week[0], week[1], [6, 7], new Set())).toEqual(['2026-10-10', '2026-10-11']);
    expect(countedDays(week[0], week[1], [1], new Set(['2026-10-05']))).toEqual([]);
    expect(countedDays(week[0], week[1], [], new Set())).toEqual([]);
  });
});

describe('time account balance', () => {
  const base = { monthlyTarget: 160, creditHours: 0, approvedPaidHours: 0 };
  it('is worked plus credited hours minus the monthly targets of the whole months before the exclusive end date', () => {
    expect(
      timeAccountBalance({
        ...base,
        startIso: '2026-01-01',
        asOfIso: '2026-03-01',
        approvedPaidHours: 300,
        creditHours: 10,
      }),
    ).toBe(-10);
    expect(
      timeAccountBalance({ ...base, startIso: '2026-01-01', asOfIso: '2026-03-02', approvedPaidHours: 0 }),
    ).toBe(-325.16);
  });
  it('prorates the first and the current month by calendar days', () => {
    // 16 of 31 days of January: 160 * 16 / 31 = 82.58
    expect(
      timeAccountBalance({ ...base, startIso: '2026-01-16', asOfIso: '2026-02-01', approvedPaidHours: 80 }),
    ).toBe(-2.58);
    // 10 of 28 days of February
    expect(
      timeAccountBalance({
        ...base,
        startIso: '2026-02-01',
        asOfIso: '2026-02-11',
        approvedPaidHours: 57.14,
      }),
    ).toBeCloseTo(0, 5);
  });
  it('adds the opening balance and gives back unpaid days at the daily target', () => {
    expect(
      timeAccountBalance({
        ...base,
        opening: 5,
        startIso: '2026-01-01',
        asOfIso: '2026-02-01',
        approvedPaidHours: 150,
      }),
    ).toBe(-5);
    expect(
      timeAccountBalance({
        ...base,
        startIso: '2026-01-01',
        asOfIso: '2026-02-01',
        approvedPaidHours: 144,
        dailyTarget: 8,
        unpaidDays: 2,
      }),
    ).toBe(0);
    expect(
      timeAccountBalance({
        ...base,
        startIso: '2026-01-01',
        asOfIso: '2026-02-01',
        approvedPaidHours: 160,
        dailyTarget: 8,
      }),
    ).toBe(0);
    expect(
      timeAccountBalance({
        ...base,
        startIso: '2026-01-01',
        asOfIso: '2026-02-01',
        approvedPaidHours: 160,
        unpaidDays: 3,
      }),
    ).toBe(0);
  });
  it('runs across a year change and is zero before the first day', () => {
    expect(
      timeAccountBalance({ ...base, startIso: '2025-12-01', asOfIso: '2026-02-01', approvedPaidHours: 320 }),
    ).toBe(0);
    expect(
      timeAccountBalance({ ...base, opening: 12.5, startIso: '2026-05-01', asOfIso: '2026-05-01' }),
    ).toBe(12.5);
  });
});
