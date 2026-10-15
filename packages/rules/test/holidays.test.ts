import { describe, expect, it } from 'vitest';
import { FEDERAL_STATE_CODES, bussUndBettag, easter, holidaysFor } from '../src';

const forState = (year: number, state: string) =>
  holidaysFor(year)
    .filter((h) => h.scope === 'national' || h.state === state)
    .map((h) => h.date);
const has = (year: number, state: string, date: string) => forState(year, state).includes(date);

describe('holidays', () => {
  it('computes Easter and Buß- und Bettag', () => {
    expect(easter(2026)).toBe('2026-04-05');
    expect(easter(2027)).toBe('2027-03-28');
    expect(bussUndBettag(2026)).toBe('2026-11-18');
    expect(bussUndBettag(2027)).toBe('2027-11-17');
    expect(bussUndBettag(2028)).toBe('2028-11-22'); // 22 Nov 2028 is a Wednesday
  });

  it('gives every state the nine national holidays and no duplicate day per state', () => {
    for (const state of FEDERAL_STATE_CODES) {
      const dates = forState(2026, state);
      expect(dates.length).toBeGreaterThanOrEqual(9);
      expect(new Set(dates).size).toBe(dates.length);
    }
  });

  it('applies state holidays to the right states (2026)', () => {
    expect(has(2026, 'BW', '2026-01-06')).toBe(true);
    expect(has(2026, 'HE', '2026-01-06')).toBe(false);
    expect(has(2026, 'BE', '2026-03-08')).toBe(true);
    expect(has(2026, 'MV', '2026-03-08')).toBe(true);
    expect(has(2026, 'HE', '2026-06-04')).toBe(true); // Fronleichnam
    expect(has(2026, 'BE', '2026-06-04')).toBe(false);
    expect(has(2026, 'SL', '2026-08-15')).toBe(true);
    expect(has(2026, 'TH', '2026-09-20')).toBe(true);
    expect(has(2026, 'SN', '2026-10-31')).toBe(true);
    expect(has(2026, 'BY', '2026-10-31')).toBe(false);
    expect(has(2026, 'NW', '2026-11-01')).toBe(true);
    expect(has(2026, 'SN', '2026-11-18')).toBe(true);
    expect(has(2026, 'BB', '2026-04-05')).toBe(true); // Ostersonntag
    expect(has(2026, 'BB', '2026-05-24')).toBe(true); // Pfingstsonntag
  });
});
