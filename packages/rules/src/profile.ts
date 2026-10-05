// Working-time limits as data (rule profiles). Pure.
export interface RuleLimits {
  /** above this a day's work is blocked (ArbZG § 3 / § 14: 10 h) */
  dailyMaxMinutes: number;
  /** above this a day's work is a warning (8 h) */
  dailyWarnMinutes: number;
  /** a rest period below this needs a reason (11 h) */
  restWarnMinutes: number;
  /** a rest period below this is blocked (10 h, hospitality exception) */
  restBlockMinutes: number;
  /** minors: minimum rest (JArbSchG § 13: 12 h) */
  minorRestMinutes: number;
  /** minors: maximum working minutes per day (8 h) */
  minorDailyMaxMinutes: number;
  /** minimum number of Sundays off per year (ArbZG § 11: 15) */
  sundaysFreeMin: number;
  /** nights per year from which a person counts as night worker (ArbZG § 2: 48) */
  nightWorkerNights: number;
}

export const DEFAULT_LIMITS: RuleLimits = {
  dailyMaxMinutes: 600,
  dailyWarnMinutes: 480,
  restWarnMinutes: 660,
  restBlockMinutes: 600,
  minorRestMinutes: 720,
  minorDailyMaxMinutes: 480,
  sundaysFreeMin: 15,
  nightWorkerNights: 48,
};

/** A profile may only be stricter than the statutory baseline. Returns one message per violated key. */
export function validateLimits(p: Partial<RuleLimits>): string[] {
  const l = { ...DEFAULT_LIMITS, ...p };
  const errs: string[] = [];
  const known = new Set(Object.keys(DEFAULT_LIMITS));
  for (const k of Object.keys(p)) if (!known.has(k)) errs.push(`${k}: unknown rule`);
  for (const [k, v] of Object.entries(p))
    if (known.has(k) && (!Number.isFinite(v) || !Number.isInteger(v))) errs.push(`${k}: must be an integer`);
  if (l.dailyMaxMinutes > DEFAULT_LIMITS.dailyMaxMinutes) errs.push('dailyMaxMinutes: may not exceed 600');
  if (l.dailyWarnMinutes > DEFAULT_LIMITS.dailyWarnMinutes) errs.push('dailyWarnMinutes: may not exceed 480');
  if (l.dailyWarnMinutes > l.dailyMaxMinutes) errs.push('dailyWarnMinutes: may not exceed dailyMaxMinutes');
  if (l.dailyWarnMinutes < 240) errs.push('dailyWarnMinutes: at least 240');
  if (l.restBlockMinutes < DEFAULT_LIMITS.restBlockMinutes) errs.push('restBlockMinutes: at least 600');
  if (l.restWarnMinutes < DEFAULT_LIMITS.restWarnMinutes) errs.push('restWarnMinutes: at least 660');
  if (l.restBlockMinutes > l.restWarnMinutes) errs.push('restBlockMinutes: may not exceed restWarnMinutes');
  if (l.restWarnMinutes > 1440) errs.push('restWarnMinutes: at most 1440');
  if (l.minorRestMinutes < DEFAULT_LIMITS.minorRestMinutes) errs.push('minorRestMinutes: at least 720');
  if (l.minorDailyMaxMinutes > DEFAULT_LIMITS.minorDailyMaxMinutes)
    errs.push('minorDailyMaxMinutes: may not exceed 480');
  if (l.minorDailyMaxMinutes < 60) errs.push('minorDailyMaxMinutes: at least 60');
  if (l.sundaysFreeMin < DEFAULT_LIMITS.sundaysFreeMin) errs.push('sundaysFreeMin: at least 15');
  if (l.sundaysFreeMin > 52) errs.push('sundaysFreeMin: at most 52');
  if (l.nightWorkerNights > DEFAULT_LIMITS.nightWorkerNights)
    errs.push('nightWorkerNights: may not exceed 48');
  if (l.nightWorkerNights < 1) errs.push('nightWorkerNights: at least 1');
  return errs;
}

export const mergeLimits = (p?: Partial<RuleLimits> | null): RuleLimits => ({
  ...DEFAULT_LIMITS,
  ...(p ?? {}),
});
