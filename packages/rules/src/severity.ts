// How strictly a planning restriction is enforced (soft or hard), configurable per company or hotel. Pure.
import type { Severity, Violation } from './checks';

/**
 * soft:   a warning, the entry can be planned anyway
 * reason: the entry can be planned, but only with a written reason (the rest-period band and availability windows)
 * hard:   planning is not possible, not even with the emergency override
 */
export type Level = 'soft' | 'reason' | 'hard';

export interface Restriction {
  code: string;
  /** the levels an admin may choose from; the statutory minimum of a restriction is never offered as "soft" */
  levels: readonly Level[];
  /** what applies when nothing was configured (the behaviour before this setting existed) */
  default: Level;
}

export const RESTRICTIONS: readonly Restriction[] = [
  { code: 'DAILY_OVER_8H', levels: ['soft', 'hard'], default: 'soft' },
  // 10 h <= rest < 11 h: allowed with a reason (compensation); below 10 h is statutory and always blocked
  { code: 'REST_PERIOD_SHORT', levels: ['reason', 'hard'], default: 'reason' },
  { code: 'MONTHLY_CAP', levels: ['soft', 'hard'], default: 'soft' },
  { code: 'SUNDAY_LIMIT', levels: ['soft', 'hard'], default: 'soft' },
  { code: 'NIGHT_WORKER', levels: ['soft', 'hard'], default: 'soft' },
  { code: 'ABSENCE_CONFLICT', levels: ['soft', 'hard'], default: 'hard' },
  { code: 'WRONG_DEPARTMENT', levels: ['soft', 'hard'], default: 'hard' },
  { code: 'UNAVAILABLE', levels: ['soft', 'reason', 'hard'], default: 'reason' },
  { code: 'WISH_CONFLICT', levels: ['soft', 'hard'], default: 'soft' },
  { code: 'QUALIFICATION_MISSING', levels: ['soft', 'hard'], default: 'soft' },
];

/** Restrictions that cannot be configured: statutory limits and the integrity of the plan. They are always hard. */
export const LOCKED_CODES: readonly string[] = [
  'DAILY_LIMIT',
  'REST_PERIOD',
  'MINOR_DAILY',
  'MINOR_NIGHT',
  'MINOR_REST',
  'OVERLAP',
  'PAST_DAY',
  'PERIOD_CLOSED',
  'NOT_AT_HOTEL',
  'CONTRACT_INACTIVE',
];

export type SeverityConfig = Partial<Record<string, Level>>;

const BY_CODE = new Map(RESTRICTIONS.map((r) => [r.code, r]));
const SEVERITY_OF: Record<Level, Severity> = { soft: 'warn', reason: 'needs_reason', hard: 'block' };

/** One message per invalid entry of a configuration; empty when it is valid. */
export function validateSeverities(cfg: Partial<Record<string, unknown>>): string[] {
  const errs: string[] = [];
  for (const [code, level] of Object.entries(cfg)) {
    const r = BY_CODE.get(code);
    if (!r) {
      errs.push(
        LOCKED_CODES.includes(code)
          ? `${code}: statutory or technical, always hard`
          : `${code}: unknown restriction`,
      );
    } else if (!r.levels.includes(level as Level)) {
      errs.push(`${code}: must be one of ${r.levels.join(', ')}`);
    }
  }
  return errs;
}

/** The level in force for every configurable restriction (configuration on top of the defaults). */
export function effectiveSeverities(cfg?: SeverityConfig | null): Record<string, Level> {
  const out: Record<string, Level> = {};
  for (const r of RESTRICTIONS) {
    const set = cfg?.[r.code];
    out[r.code] = set && r.levels.includes(set) ? set : r.default;
  }
  return out;
}

/** The restriction a violation belongs to; below 10 h of rest is statutory and not configurable. */
const restrictionOf = (v: Violation): string | null =>
  v.code === 'REST_PERIOD' ? (v.severity === 'needs_reason' ? 'REST_PERIOD_SHORT' : null) : v.code;

/**
 * Applies the configured levels to the violations of one check. A restriction that was set to hard is marked
 * (`details.configuredHard`) so that the emergency override, which exists for statutory limits only, leaves it alone.
 */
export function applySeverities(violations: Violation[], cfg?: SeverityConfig | null): Violation[] {
  if (!cfg) return violations;
  return violations.map((v) => {
    const key = restrictionOf(v);
    const r = key ? BY_CODE.get(key) : undefined;
    const level = key ? cfg[key] : undefined;
    if (!r || !level || !r.levels.includes(level)) return v;
    return {
      ...v,
      severity: SEVERITY_OF[level],
      details: level === 'hard' ? { ...v.details, configuredHard: true } : v.details,
    };
  });
}
