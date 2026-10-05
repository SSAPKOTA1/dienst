import { describe, expect, it } from 'vitest';
import { absenceLimitIssues, wishConflicts } from '../src';

const base = { days: ['2027-02-08', '2027-02-09'], departmentId: 1, absentOthers: {}, departmentCap: null };

describe('absenceLimitIssues', () => {
  it('finds a blackout without capacity and lists the affected days', () => {
    const v = absenceLimitIssues({
      ...base,
      blackouts: [
        {
          id: 7,
          departmentId: null,
          from: '2027-02-09',
          to: '2027-02-20',
          reason: 'Fair',
          maxConcurrentAbsent: null,
        },
      ],
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      code: 'BLACKOUT',
      severity: 'needs_reason',
      details: { blackoutId: 7, dates: ['2027-02-09'] },
    });
  });
  it('ignores blackouts of other departments and outside the days', () => {
    expect(
      absenceLimitIssues({
        ...base,
        blackouts: [
          {
            id: 1,
            departmentId: 2,
            from: '2027-02-01',
            to: '2027-02-28',
            reason: null,
            maxConcurrentAbsent: null,
          },
        ],
      }),
    ).toEqual([]);
    expect(
      absenceLimitIssues({
        ...base,
        blackouts: [
          {
            id: 1,
            departmentId: null,
            from: '2027-03-01',
            to: '2027-03-05',
            reason: null,
            maxConcurrentAbsent: null,
          },
        ],
      }),
    ).toEqual([]);
  });
  it('caps concurrent absences by blackout and by department default', () => {
    const b = [
      { id: 3, departmentId: 1, from: '2027-02-01', to: '2027-02-28', reason: null, maxConcurrentAbsent: 2 },
    ];
    expect(absenceLimitIssues({ ...base, blackouts: b, absentOthers: { '2027-02-08': 1 } })).toEqual([]);
    const v = absenceLimitIssues({
      ...base,
      blackouts: b,
      absentOthers: { '2027-02-08': 2, '2027-02-09': 1 },
    });
    expect(v.map((x) => x.code)).toEqual(['MAX_CONCURRENT']);
    expect(v[0]!.details.dates).toEqual(['2027-02-08']);
    const d = absenceLimitIssues({
      ...base,
      blackouts: [],
      departmentCap: 1,
      absentOthers: { '2027-02-09': 1 },
    });
    expect(d[0]).toMatchObject({ code: 'MAX_CONCURRENT', details: { max: 1, dates: ['2027-02-09'] } });
  });
  it('a cap of 0 behaves like a blackout', () => {
    const v = absenceLimitIssues({
      ...base,
      blackouts: [
        {
          id: 4,
          departmentId: null,
          from: '2027-02-08',
          to: '2027-02-08',
          reason: null,
          maxConcurrentAbsent: 0,
        },
      ],
    });
    expect(v[0]!.code).toBe('MAX_CONCURRENT');
  });
});

describe('wishConflicts', () => {
  const day = { localDate: '2027-05-11', shiftId: 5 };
  it('warns for a leave wish that covers the day and for a different shift wish', () => {
    expect(wishConflicts(day, [], [{ from: '2027-05-10', to: '2027-05-14', priority: 1 }])[0]).toMatchObject({
      code: 'WISH_CONFLICT',
      severity: 'warn',
      details: { kind: 'leave', priority: 1 },
    });
    expect(
      wishConflicts(
        day,
        [
          { date: '2027-05-11', shiftId: 6, priority: 3 },
          { date: '2027-05-11', shiftId: 7, priority: 2 },
        ],
        [],
      )[0],
    ).toMatchObject({ details: { kind: 'shift', priority: 2 } });
  });
  it('is silent when the entry matches the wish or nothing overlaps', () => {
    expect(wishConflicts(day, [{ date: '2027-05-11', shiftId: 5, priority: 1 }], [])).toEqual([]);
    expect(
      wishConflicts(
        day,
        [{ date: '2027-05-12', shiftId: 6, priority: 1 }],
        [{ from: '2027-06-01', to: '2027-06-02', priority: 1 }],
      ),
    ).toEqual([]);
  });
});

import { availabilityConflicts, qualificationIssue, type AvailabilityRule } from '../src';

describe('availabilityConflicts', () => {
  // 2027-02-08 is a Monday
  const mon: AvailabilityRule = {
    weekday: 1,
    fromMin: 600,
    toMin: 720,
    kind: 'unavailable',
    validFrom: '2027-01-01',
    validTo: null,
    note: 'course',
  };
  const entry = { localDate: '2027-02-08', startLocalMin: 660, endLocalMin: 900 };

  it('needs a reason when the entry overlaps an unavailable window', () => {
    const v = availabilityConflicts(entry, [mon]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ code: 'UNAVAILABLE', severity: 'needs_reason' });
    expect(v[0]!.details).toMatchObject({ date: '2027-02-08', note: 'course' });
  });
  it('ignores preferred windows, other weekdays, touching times and expired windows', () => {
    expect(availabilityConflicts(entry, [{ ...mon, kind: 'preferred' }])).toEqual([]);
    expect(availabilityConflicts(entry, [{ ...mon, weekday: 2 }])).toEqual([]);
    expect(availabilityConflicts({ ...entry, startLocalMin: 720 }, [mon])).toEqual([]);
    expect(availabilityConflicts(entry, [{ ...mon, validTo: '2027-02-01' }])).toEqual([]);
    expect(availabilityConflicts(entry, [{ ...mon, validFrom: '2027-03-01' }])).toEqual([]);
  });
  it('checks the next day for an entry that runs past midnight', () => {
    const tue: AvailabilityRule = { ...mon, weekday: 2, fromMin: 0, toMin: 120, note: null };
    const v = availabilityConflicts({ localDate: '2027-02-08', startLocalMin: 1320, endLocalMin: 1500 }, [
      tue,
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]!.details).toMatchObject({ date: '2027-02-09', note: null });
  });
});

describe('qualificationIssue', () => {
  it('passes without a requirement or with a valid qualification', () => {
    expect(qualificationIssue(null, [], '2027-02-08')).toEqual([]);
    expect(qualificationIssue(3, [{ id: 3, validUntil: null }], '2027-02-08')).toEqual([]);
    expect(qualificationIssue(3, [{ id: 3, validUntil: '2027-02-08' }], '2027-02-08')).toEqual([]);
  });
  it('warns when it is missing or expired', () => {
    const missing = qualificationIssue(3, [], '2027-02-08');
    expect(missing[0]).toMatchObject({ code: 'QUALIFICATION_MISSING', severity: 'warn' });
    expect(missing[0]!.details).toMatchObject({ expired: false });
    const expired = qualificationIssue(3, [{ id: 3, validUntil: '2027-02-07' }], '2027-02-08');
    expect(expired[0]!.details).toMatchObject({ expired: true, validUntil: '2027-02-07' });
  });
});
