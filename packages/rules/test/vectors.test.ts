import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  requiredBreakMinutes,
  paidHours,
  variationMinutes,
  withinGrace,
  proratedVacationDays,
  restPeriodResult,
  dailyLimitResult,
  durationMinutes,
  displayName,
  sickBackdateAllowed,
  openSlots,
  usernameBase,
  nextUsername,
  timeAccountBalance,
  overlapsNightWindow,
  ageOn,
} from '../src';

const here = path.dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(readFileSync(path.join(here, '../../../tests/vectors.json'), 'utf8'));

describe('tests/vectors.json', () => {
  it('requiredBreak', () => {
    for (const r of v.requiredBreak)
      expect(requiredBreakMinutes(r.grossMinutes), JSON.stringify(r)).toBe(r.expected);
  });
  it('paidHours', () => {
    for (const r of v.paidHours)
      expect(paidHours(r.grossMinutes, r.breakMinutes), JSON.stringify(r)).toBe(r.expected);
  });
  it('grace', () => {
    for (const r of v.grace) {
      const m = variationMinutes(r.actual, r.planned);
      expect(m, JSON.stringify(r)).toBe(r.variationMinutes);
      expect(withinGrace(m)).toBe(r.withinGrace);
    }
  });
  it('vacationProration', () => {
    for (const r of v.vacationProration)
      expect(proratedVacationDays(r.annualDays, r.contractStart, r.year), JSON.stringify(r)).toBe(r.expected);
  });
  it('restPeriod', () => {
    for (const r of v.restPeriod) expect(restPeriodResult(r.gapMinutes), JSON.stringify(r)).toBe(r.expected);
  });
  it('dailyLimit', () => {
    for (const r of v.dailyLimit) expect(dailyLimitResult(r.workMinutes), JSON.stringify(r)).toBe(r.expected);
  });
  it('dstDurations', () => {
    for (const r of v.dstDurations)
      expect(durationMinutes(r.start, r.end), JSON.stringify(r)).toBe(r.expectedMinutes);
  });
  it('displayName', () => {
    for (const r of v.displayName) expect(displayName(r.firstName, r.lastName)).toBe(r.expected);
  });
  it('sickBackdate', () => {
    for (const r of v.sickBackdate)
      expect(sickBackdateAllowed(r.today, r.day, r.limitDays), JSON.stringify(r)).toBe(r.managerAllowed);
  });
  it('openSlots', () => {
    for (const r of v.openSlots) expect(openSlots(r.required, r.assigned)).toBe(r.expected);
  });
  it('usernames', () => {
    for (const r of v.usernames)
      expect(nextUsername(usernameBase(r.first, r.last), new Set(r.taken)), JSON.stringify(r)).toBe(
        r.expected,
      );
  });
  it('timeAccount', () => {
    for (const r of v.timeAccount) {
      expect(
        timeAccountBalance({
          opening: r.opening,
          monthlyTarget: r.monthlyTarget,
          startIso: r.startIso,
          asOfIso: r.asOfIso,
          approvedPaidHours: r.approvedPaidHours,
          creditHours: r.creditHours,
          unpaidDays: r.unpaidDays,
          dailyTarget: r.dailyTarget,
        }),
        JSON.stringify(r),
      ).toBe(r.expected);
    }
  });
  it('minorNightWindow', () => {
    const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
    for (const r of v.minorNightWindow) {
      const s = toMin(r.shiftStart);
      let e = toMin(r.shiftEnd);
      if (e <= s) e += 1440;
      const blocked = r.age < 18 && overlapsNightWindow(s, e);
      expect(blocked ? 'blocked' : 'ok', JSON.stringify(r)).toBe(r.expected);
    }
  });
  it('ageOn', () => {
    expect(ageOn('2009-02-14', '2026-10-01')).toBe(17);
    expect(ageOn('2008-10-02', '2026-10-01')).toBe(17);
    expect(ageOn('2008-10-01', '2026-10-01')).toBe(18);
  });
});
