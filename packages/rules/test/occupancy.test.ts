import { describe, expect, it } from 'vitest';
import { buildSuggestion, suggestHeadcount } from '../src';

const ladder = [
  { minOccupancyPct: 80, headcount: 5 },
  { minOccupancyPct: 0, headcount: 2 },
  { minOccupancyPct: 50, headcount: 3 },
];

describe('suggestHeadcount', () => {
  it('takes the highest threshold that is reached, whatever the order of the rules', () => {
    expect(suggestHeadcount(100, ladder)).toBe(5);
    expect(suggestHeadcount(80, ladder)).toBe(5);
    expect(suggestHeadcount(79, ladder)).toBe(3);
    expect(suggestHeadcount(50, ladder)).toBe(3);
    expect(suggestHeadcount(49, ladder)).toBe(2);
    expect(suggestHeadcount(0, ladder)).toBe(2);
  });
  it('gives nothing without a reached rule', () => {
    expect(suggestHeadcount(40, [{ minOccupancyPct: 60, headcount: 4 }])).toBeNull();
    expect(suggestHeadcount(40, [])).toBeNull();
  });
});

describe('buildSuggestion', () => {
  it('compares the suggestion with the requirement and the plan', () => {
    const s = buildSuggestion({
      date: '2027-03-01',
      shiftId: 1,
      occupancyPct: 85,
      rules: ladder,
      required: 3,
      planned: 2,
    });
    expect(s).toMatchObject({ suggested: 5, deltaToRequired: 2, gap: 3 });
    expect(
      buildSuggestion({
        date: '2027-03-01',
        shiftId: 1,
        occupancyPct: 10,
        rules: [],
        required: 3,
        planned: 2,
      }),
    ).toBeNull();
  });
});
