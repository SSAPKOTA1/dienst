// Property-based tests (fast-check): laws that must hold for every input, not just the vectors.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  addDays,
  ageOn,
  aggregate,
  checkEntry,
  dailyLimitResult,
  DEFAULT_LIMITS,
  eachDay,
  isNightWork,
  isoWeekday,
  isWeakPin,
  isMinor,
  mondayOf,
  nightMinutesOf,
  overlapsNightWindow,
  paidHours,
  proratedVacationDays,
  requiredBreakMinutes,
  restCompensations,
  restPeriodResult,
  suggestHeadcount,
  type CheckInput,
  type Violation,
} from '../src';

const dateArb = fc
  .date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2034-12-31T00:00:00Z'), noInvalidDate: true })
  .map((d) => d.toISOString().slice(0, 10));
const rank = { blocked: 0, needs_reason: 1, ok: 2 } as const;

describe('breaks and paid hours (ArbZG §4)', () => {
  it('the required break never shrinks when the gross time grows, and stays within 0..45', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1500 }), fc.integer({ min: 0, max: 600 }), (g, extra) => {
        const a = requiredBreakMinutes(g);
        const b = requiredBreakMinutes(g + extra);
        return a >= 0 && a <= 45 && b >= a;
      }),
    );
  });
  it('up to 6 h no break; the break never exceeds the time worked over 6 h', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1500 }), (g) => {
        const b = requiredBreakMinutes(g);
        return (g <= 360 ? b === 0 : true) && (g > 360 && g <= 390 ? b === g - 360 : true);
      }),
    );
  });
  it('paid hours are the net time in hours, rounded to 2 decimals, and fall when the break grows', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1500 }), fc.integer({ min: 0, max: 120 }), (g, b) => {
        const p = paidHours(g, b);
        return Math.abs(p - (g - b) / 60) <= 0.005 + 1e-9 && paidHours(g, b + 1) <= p;
      }),
    );
  });
});

describe('rest period and daily limit are monotone', () => {
  it('a longer rest is never classified worse', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2000 }), fc.integer({ min: 0, max: 600 }), (gap, extra) => {
        return rank[restPeriodResult(gap + extra)] >= rank[restPeriodResult(gap)];
      }),
    );
  });
  it('more work in a day is never classified better', () => {
    const order = { ok: 2, warn: 1, blocked: 0 } as const;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 600 }), (w, extra) => {
        return order[dailyLimitResult(w + extra)] <= order[dailyLimitResult(w)];
      }),
    );
  });
  it('the thresholds are exact: 600 min rest blocks below, 660 min needs a reason below, 480 and 600 min work', () => {
    expect(restPeriodResult(599)).toBe('blocked');
    expect(restPeriodResult(600)).toBe('needs_reason');
    expect(restPeriodResult(659)).toBe('needs_reason');
    expect(restPeriodResult(660)).toBe('ok');
    expect(dailyLimitResult(480)).toBe('ok');
    expect(dailyLimitResult(481)).toBe('warn');
    expect(dailyLimitResult(600)).toBe('warn');
    expect(dailyLimitResult(601)).toBe('blocked');
  });
});

describe('date helpers', () => {
  it('addDays is reversible and shifts the weekday by n modulo 7', () => {
    fc.assert(
      fc.property(dateArb, fc.integer({ min: -4000, max: 4000 }), (d, n) => {
        const moved = addDays(d, n);
        const wd = ((isoWeekday(d) - 1 + (n % 7) + 7) % 7) + 1;
        return addDays(moved, -n) === d && isoWeekday(moved) === wd;
      }),
    );
  });
  it('mondayOf is a Monday within the last six days, and a Monday maps to itself', () => {
    fc.assert(
      fc.property(dateArb, (d) => {
        const m = mondayOf(d);
        const back = (Date.parse(`${d}T00:00:00Z`) - Date.parse(`${m}T00:00:00Z`)) / 86400000;
        return isoWeekday(m) === 1 && back >= 0 && back <= 6 && mondayOf(m) === m;
      }),
    );
  });
  it('eachDay lists every day once, in order', () => {
    fc.assert(
      fc.property(dateArb, fc.integer({ min: 0, max: 400 }), (d, n) => {
        const days = eachDay(d, addDays(d, n));
        return days.length === n + 1 && days[0] === d && days.every((x, i) => i === 0 || x > days[i - 1]!);
      }),
    );
  });
});

describe('vacation proration (BUrlG)', () => {
  it('stays between 0 and the annual days, is the full entitlement for an earlier start, and never rises for a later start', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 2021, max: 2032 }),
        dateArb,
        dateArb,
        (annual, year, a, b) => {
          const [early, late] = a <= b ? [a, b] : [b, a];
          const pe = proratedVacationDays(annual, early, year);
          const pl = proratedVacationDays(annual, late, year);
          const fullBefore = proratedVacationDays(annual, `${year - 1}-12-31`, year) === annual;
          const none = proratedVacationDays(annual, `${year + 1}-01-01`, year) === 0;
          return pe >= 0 && pe <= annual && pl <= pe && fullBefore && none;
        },
      ),
    );
  });
});

describe('minors (JArbSchG)', () => {
  it('age counts completed years: one day before the birthday is one year less, and age never falls over time', () => {
    fc.assert(
      fc.property(
        dateArb,
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 400 }),
        (dob, days, more) => {
          const day = addDays(dob, days);
          const later = addDays(day, more);
          return ageOn(dob, later) >= ageOn(dob, day) && ageOn(dob, day) >= 0;
        },
      ),
    );
  });
  it('the 18th birthday turns a minor into an adult on that very day (also for 29 February births)', () => {
    for (const dob of ['2008-02-29', '2008-03-01', '2007-12-31', '2010-06-15']) {
      const y = Number(dob.slice(0, 4)) + 18;
      const birthday = dob.slice(5) === '02-29' ? `${y}-03-01` : `${y}-${dob.slice(5)}`;
      expect(isMinor(dob, addDays(birthday, -1))).toBe(true);
      expect(isMinor(dob, birthday)).toBe(false);
    }
  });
  it('night window for minors agrees with a minute-by-minute scan of 20:00-06:00', () => {
    const inNight = (m: number) => {
      const t = m % 1440;
      return t < 360 || t >= 1200;
    };
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1500 }), fc.integer({ min: 1, max: 1500 }), (s, len) => {
        let scan = false;
        for (let m = s; m < s + len; m++) if (inNight(m)) scan = true;
        return overlapsNightWindow(s, s + len) === scan;
      }),
    );
  });
});

describe('night work (ArbZG §6)', () => {
  const night = (m: number) => {
    const t = m % 1440;
    return t < 360 || t >= 1380;
  };
  it('night minutes equal a minute-by-minute scan of 23:00-06:00', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1700 }), fc.integer({ min: 0, max: 900 }), (s, len) => {
        let scan = 0;
        for (let m = s; m < s + len; m++) if (night(m)) scan++;
        return nightMinutesOf(s, s + len) === scan;
      }),
    );
  });
  it('night minutes are additive over a split and never exceed the length', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1700 }),
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 0, max: 500 }),
        (s, l1, l2) => {
          const total = nightMinutesOf(s, s + l1 + l2);
          return (
            total === nightMinutesOf(s, s + l1) + nightMinutesOf(s + l1, s + l1 + l2) && total <= l1 + l2
          );
        },
      ),
    );
  });
  it('"night" needs at least two night minutes-hours', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1700 }), fc.integer({ min: 0, max: 900 }), (s, len) => {
        return isNightWork(s, s + len) === nightMinutesOf(s, s + len) >= 120;
      }),
    );
  });
});

describe('PIN policy', () => {
  it('repeated digits, straight runs and non-digits are weak', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9 }), fc.integer({ min: 4, max: 8 }), (d, n) =>
        isWeakPin(String(d).repeat(n)),
      ),
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 4, max: 5 }), (from, n) => {
        const asc = Array.from({ length: n }, (_, i) => from + i)
          .filter((x) => x <= 9)
          .join('');
        return asc.length < 4 || isWeakPin(asc);
      }),
    );
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => /\D/.test(s)),
        (s) => isWeakPin(s),
      ),
    );
  });
  it('a PIN with a break in the pattern is accepted', () => {
    for (const ok of ['482915', '736204', '1357', '2468', '9081']) expect(isWeakPin(ok)).toBe(false);
  });
});

describe('rest compensation (ArbZG §5)', () => {
  const shiftsArb = fc
    .array(fc.tuple(fc.integer({ min: 0, max: 60 * 24 * 40 }), fc.integer({ min: 240, max: 720 })), {
      minLength: 0,
      maxLength: 12,
    })
    .map((xs) =>
      xs.map(([startMin, len]) => ({ startMs: startMin * 60000, endMs: (startMin + len) * 60000 })),
    );
  const nonOverlapping = shiftsArb.map((list) => {
    const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
    const out: typeof sorted = [];
    for (const s of sorted) if (!out.length || s.startMs >= out[out.length - 1]!.endMs) out.push(s);
    return out;
  });
  it('lists only rests of 10 to under 11 hours; status ok exactly when a later 12 h rest was found', () => {
    fc.assert(
      fc.property(nonOverlapping, fc.integer({ min: 0, max: 60 * 24 * 90 }), (shifts, nowMin) => {
        for (const c of restCompensations(shifts, nowMin * 60000)) {
          if (c.gapMinutes < 600 || c.gapMinutes >= 660) return false;
          if ((c.status === 'ok') !== (c.compensatedByMs !== null)) return false;
          if (c.status === 'overdue' && !(nowMin * 60000 > c.dueMs)) return false;
        }
        return true;
      }),
    );
  });
  it('does not depend on the order in which the shifts are given', () => {
    fc.assert(
      fc.property(nonOverlapping, fc.integer({ min: 0, max: 60 * 24 * 90 }), (shifts, nowMin) => {
        const a = restCompensations(shifts, nowMin * 60000);
        const b = restCompensations([...shifts].reverse(), nowMin * 60000);
        return JSON.stringify(a) === JSON.stringify(b);
      }),
    );
  });
});

describe('occupancy rule choice', () => {
  const rulesArb = fc.array(
    fc.record({
      minOccupancyPct: fc.integer({ min: 0, max: 100 }),
      headcount: fc.integer({ min: 0, max: 30 }),
    }),
    { maxLength: 8 },
  );
  it('uses the rule with the highest threshold that is met; none when no threshold is met', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), rulesArb, (occ, rules) => {
        const met = rules.filter((r) => occ >= r.minOccupancyPct);
        const got = suggestHeadcount(occ, rules);
        if (!met.length) return got === null;
        const top = Math.max(...met.map((r) => r.minOccupancyPct));
        return met.filter((r) => r.minOccupancyPct === top).some((r) => r.headcount === got);
      }),
    );
  });
});

describe('aggregation of findings', () => {
  const sev = fc.constantFrom<Violation['severity']>('block', 'needs_reason', 'warn');
  const code = fc.constantFrom(
    'DAILY_LIMIT',
    'MINOR_REST',
    'REST_PERIOD',
    'OVERLAP',
    'MINOR_NIGHT',
    'PAST_DAY',
    'WISH_CONFLICT',
  );
  const vioArb = fc.array(
    fc.record({ code, severity: sev, message: fc.constant('m'), details: fc.constant({}) }),
    { maxLength: 10 },
  );
  it('a manager can never override, and only the three overridable codes ever change', () => {
    fc.assert(
      fc.property(vioArb, fc.boolean(), (vs, emergency) => {
        const m = aggregate(vs, { role: 'manager', emergencyOverride: emergency });
        const a = aggregate(vs, { role: 'admin', emergencyOverride: emergency });
        const changed = a.violations.filter((x, i) => x.severity !== vs[i]!.severity);
        return (
          m.overridden.length === 0 &&
          JSON.stringify(m.violations) === JSON.stringify(vs) &&
          changed.every((x) => ['DAILY_LIMIT', 'MINOR_REST', 'REST_PERIOD'].includes(x.code))
        );
      }),
    );
  });
  it('the status is the worst severity present, and an override never makes it worse', () => {
    fc.assert(
      fc.property(vioArb, (vs) => {
        const plain = aggregate(vs, { role: 'admin' });
        const over = aggregate(vs, { role: 'admin', emergencyOverride: true });
        const worst = vs.some((x) => x.severity === 'block')
          ? 'blocked'
          : vs.some((x) => x.severity === 'needs_reason')
            ? 'needs_reason'
            : 'ok';
        return plain.status === worst && rank[over.status] >= rank[plain.status];
      }),
    );
  });
});

describe('entry checks', () => {
  const base = (over: Partial<CheckInput['entry']> = {}, minutes = 480, brk = 30): CheckInput => {
    const startMs = Date.UTC(2027, 5, 7, 6, 0);
    return {
      entry: {
        hotelId: 1,
        departmentId: 1,
        startMs,
        endMs: startMs + (minutes + brk) * 60000,
        breakMinutes: brk,
        localDate: '2027-06-07',
        startLocalMin: 8 * 60,
        endLocalMin: 8 * 60 + minutes + brk,
        ...over,
      },
      employee: { dateOfBirth: '1990-01-01', active: true, hotelIds: [1], departmentIds: [1] },
      contractActive: true,
      monthlyHoursCap: null,
      others: [],
      absenceOnDay: false,
      periodClosed: false,
      today: '2027-06-01',
    };
  };
  const codes = (i: CheckInput) => checkEntry(i).map((x) => x.code);
  it('a day over 10 working hours always blocks, up to 8 hours never raises a daily finding', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 900 }), (m) => {
        const c = codes(base({}, m, 30));
        return (
          (m > DEFAULT_LIMITS.dailyMaxMinutes ? c.includes('DAILY_LIMIT') : !c.includes('DAILY_LIMIT')) &&
          (m <= DEFAULT_LIMITS.dailyWarnMinutes
            ? !c.includes('DAILY_OVER_8H') && !c.includes('DAILY_LIMIT')
            : true)
        );
      }),
    );
  });
  it('an overlapping entry blocks; a non-overlapping one on another day does not', () => {
    fc.assert(
      fc.property(fc.integer({ min: -600, max: 600 }), (shiftMin) => {
        const i = base();
        const o = {
          id: 9,
          startMs: i.entry.startMs + shiftMin * 60000,
          endMs: i.entry.startMs + shiftMin * 60000 + 240 * 60000,
          breakMinutes: 0,
          localDate: '2027-06-07',
        };
        const overlaps = o.startMs < i.entry.endMs && o.endMs > i.entry.startMs;
        return codes({ ...i, others: [o] }).includes('OVERLAP') === overlaps;
      }),
    );
  });
  it('findings never depend on the order of the other entries', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -3000, max: 3000 }), { maxLength: 6 }), (offsets) => {
        const i = base();
        const others = offsets.map((m, idx) => ({
          id: idx,
          startMs: i.entry.startMs + m * 60000,
          endMs: i.entry.startMs + m * 60000 + 300 * 60000,
          breakMinutes: 0,
          localDate: new Date(i.entry.startMs + m * 60000).toISOString().slice(0, 10),
        }));
        const a = checkEntry({ ...i, others })
          .map((x) => `${x.code}:${x.severity}`)
          .sort();
        const b = checkEntry({ ...i, others: [...others].reverse() })
          .map((x) => `${x.code}:${x.severity}`)
          .sort();
        return JSON.stringify(a) === JSON.stringify(b);
      }),
    );
  });
  it('an employee under 18 is blocked for more than 8 hours and for work in the 20:00-06:00 window, an adult is not', () => {
    fc.assert(
      fc.property(fc.integer({ min: 60, max: 720 }), fc.integer({ min: 0, max: 1400 }), (m, startMin) => {
        const i = base({ startLocalMin: startMin, endLocalMin: startMin + m + 30 }, m, 30);
        const minor = checkEntry({ ...i, employee: { ...i.employee, dateOfBirth: '2012-01-01' } }).map(
          (x) => x.code,
        );
        const adult = checkEntry(i).map((x) => x.code);
        return (
          (m > DEFAULT_LIMITS.minorDailyMaxMinutes
            ? minor.includes('MINOR_DAILY')
            : !minor.includes('MINOR_DAILY')) &&
          minor.includes('MINOR_NIGHT') === overlapsNightWindow(startMin, startMin + m + 30) &&
          !adult.includes('MINOR_DAILY') &&
          !adult.includes('MINOR_NIGHT')
        );
      }),
    );
  });
});
