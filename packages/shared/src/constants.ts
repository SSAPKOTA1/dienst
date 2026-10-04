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

export const MENU_ABSENCE_TYPES = [
  'sick_leave',
  'off_day',
  'annual_leave',
  'unpaid_leave',
  'vocational_school',
] as const;
export type MenuAbsenceType = (typeof MENU_ABSENCE_TYPES)[number];
