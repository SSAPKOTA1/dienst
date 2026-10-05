export const ROLES = ['superAdmin', 'admin', 'manager', 'employee'] as const;
export type Role = (typeof ROLES)[number];

export const PLANNER_ROLES = ['superAdmin', 'admin', 'manager'] as const;

/** Maps API role names to the values stored in `*_role` columns. */
export const ROLE_DB = {
  superAdmin: 'super_admin',
  admin: 'admin',
  manager: 'manager',
  employee: 'employee',
} as const;

export const DEFAULT_TIMEZONE = 'Europe/Berlin';
export const BREAK_OPTIONS = [0, 15, 30, 45, 60] as const;

/** shown directly in the planner's + menu */
export const PRIMARY_ABSENCE_TYPES = [
  'sick_leave',
  'off_day',
  'annual_leave',
  'unpaid_leave',
  'vocational_school',
] as const;
/** under "More" in the + menu (backlog) */
export const EXTRA_ABSENCE_TYPES = [
  'comp_time',
  'special_leave',
  'child_sick',
  'training',
  'parental_leave',
  'maternity_leave',
  'rest_day',
] as const;
export const MENU_ABSENCE_TYPES = [...PRIMARY_ABSENCE_TYPES, ...EXTRA_ABSENCE_TYPES] as const;

/** Company feature toggles (a missing row means enabled). */
export const FEATURES = [
  'wishes',
  'swaps',
  'open_shifts',
  'availability',
  'announcements',
  'feed',
  'messages',
  'documents',
  'calendar_feed',
  'team_calendar',
] as const;
export type Feature = (typeof FEATURES)[number];
export type MenuAbsenceType = (typeof MENU_ABSENCE_TYPES)[number];
