/**
 * Response shapes shared by the API and the web app. The API mappers (`xOut` in `apps/api/src/routes`) are
 * annotated with these types, so a change on the server that breaks the web fails to compile.
 * Dates are `YYYY-MM-DD`, timestamps ISO-8601 strings.
 */
export interface Items<T> {
  items: T[];
}

export interface CompanyDto {
  id: number;
  name: string;
  graceMinutes: number;
  sickBackdateDays: number;
  pinLength: number;
}
export interface HotelDto {
  id: number;
  companyId: number;
  name: string;
  city: string | null;
  federalState: string | null;
  timezone: string;
  employeeHoursVisibility: string;
  /** false: switched off by the super admin (hidden from planning and the tablet, history kept) */
  isActive: boolean;
}
/** The staff roles one person holds (super admin only); the employee role follows the employee record. */
export interface StaffRolesDto {
  userId: number;
  name: string;
  email: string | null;
  isEmployee: boolean;
  superAdmin: boolean;
  admin: { companyIds: number[]; hotelIds: number[] } | null;
  manager: { hotelIds: number[] } | null;
}
export interface HotelSettingsDto {
  hotelId: number;
  employeeHoursVisibility: string;
  breakMode: string;
  kioskIdentification: string;
  allowWebPunch: boolean;
  webPunchAllowedCidrs: string[];
}
export interface DepartmentDto {
  id: number;
  hotelId: number;
  name: string;
  color: string | null;
}
export interface KioskDeviceDto {
  id: number;
  hotelId: number;
  name: string;
  status: string;
  lastSeenAt: string | null;
  online: boolean;
}
export interface ShiftDto {
  id: number;
  hotelId: number;
  departmentId: number;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  requiredQualificationId: number | null;
  /** present in the staffing view of a shift: required headcount per ISO weekday and per date */
  weekdayDefaults?: Record<string, number>;
  overrides?: Array<{ date: string; count: number }>;
}
export interface QualificationDto {
  id: number;
  name: string;
  hasExpiry: boolean;
}
export interface AvailabilityDto {
  id: number;
  weekday: number;
  from: string;
  to: string;
  kind: string;
  validFrom: string;
  validTo: string | null;
  note: string | null;
}
export interface DocumentDto {
  id: number;
  employeeId: number;
  docType: string;
  title: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  validUntil: string | null;
  visibleToEmployee: boolean;
  createdAt: string | null;
}
export interface BlackoutDto {
  id: number;
  hotelId: number;
  departmentId: number | null;
  from: string;
  to: string;
  reason: string | null;
  maxConcurrentAbsent: number | null;
}
export interface ShiftWishDto {
  id: number;
  date: string;
  shiftId: number;
  hotelId: number;
  priority: number;
  reason: string | null;
  status: string;
  decisionNote: string | null;
}
export interface LeaveWishDto {
  id: number;
  from: string;
  to: string;
  days: number | string;
  priority: number;
  reason: string | null;
  status: string;
  decisionNote: string | null;
}
export interface TimeOffRequestDto {
  id: number;
  from: string;
  to: string;
  days: number | string;
  halfDay: string | null;
  reason: string | null;
  status: string;
  decisionNote: string | null;
  createdAt: string | null;
}
export interface CorrectionDto {
  id: number;
  type: string;
  punchRecordId: number | null;
  requestedIn: string | null;
  requestedOut: string | null;
  requestedBreakMinutes: number | null;
  reason: string | null;
  status: string;
  decisionNotes: string | null;
  createdAt: string | null;
  decidedAt: string | null;
}
export interface NotificationDto {
  id: number;
  kind: string;
  payload: unknown;
  read: boolean;
  createdAt: string | null;
}
export interface SwapDto {
  id: number;
  hotelId: number;
  scheduleId: number;
  requesterEmployeeId: number;
  counterpartEmployeeId: number | null;
  counterpartScheduleId: number | null;
  status: string;
  reason: string | null;
  decisionNote: string | null;
  expiresAt: string;
  createdAt: string | null;
}
export interface OpenShiftDto {
  id: number;
  hotelId: number;
  departmentId: number;
  shiftId: number | null;
  date: string;
  start: string;
  end: string;
  breakMinutes: number;
  status: string;
}
export interface StaffingRuleDto {
  id: number;
  hotelId: number;
  shiftId: number;
  shiftName?: string;
  minOccupancyPct: number;
  headcount: number;
}
export interface PayrollPeriodDto {
  id: number;
  companyId: number;
  hotelId: number | null;
  from: string;
  to: string;
  status: string;
  closedAt: string | null;
  closedByUserId: number | null;
  reopenReason: string | null;
}
export interface HourCategoryDto {
  id: number | null;
  code: string;
  name: string;
  rule: unknown;
  active: boolean;
  system: boolean;
}
export interface ContractDto {
  id: number;
  validFrom: string;
  validTo: string | null;
  employmentType: string;
  workingModel: string;
  workDaysPerWeek: number;
  workingWeekdays: number[];
  targetHoursPerWeek: number | string | null;
  targetHoursPerMonth: number | string | null;
  dailyTargetHours: number | string | null;
  vacationDaysPerYear: number | string;
  monthlyHoursCap: number | string | null;
  getsPublicHoliday: boolean;
}

export interface Paged<T> extends Items<T> {
  page: number;
  pageSize: number;
  total: number;
}

export interface NamedRef {
  id: number;
  name: string;
}
export type EmployeeViewKind = 'full' | 'home' | 'reduced' | 'self';
export interface VacationSummaryDto {
  year: number;
  allocated: number;
  used: number;
  remaining: number;
}
/** Row of the staff list; fields beyond the base ones depend on the reader's `view`. */
export interface EmployeeSummaryDto {
  employeeId: number;
  displayName: string | null;
  personnelNumber: string;
  department: NamedRef;
  homeHotel: NamedRef;
  status: string;
  isFloater: boolean;
  isMinor: boolean;
  view: EmployeeViewKind;
  targetHoursPerWeek?: number | null;
  employmentType?: string | null;
  vacationRemaining?: number;
  timeAccount?: number | null;
  firstName?: string;
  lastName?: string;
  email?: string | null;
}
/** One person's record; `reduced` readers get the base fields, `home` also the contract summary, `full` and `self` everything. */
export interface EmployeeDetailDto {
  employeeId: number;
  displayName: string | null;
  personnelNumber: string;
  homeHotel: NamedRef;
  department: NamedRef;
  isFloater: boolean;
  isMinor: boolean;
  status: string;
  view: EmployeeViewKind;
  workingWeekdays?: number[];
  workDaysPerWeek?: number | null;
  targetHoursPerWeek?: number | null;
  employmentType?: string | null;
  vacation?: VacationSummaryDto;
  timeAccount?: number | null;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  email?: string | null;
  phone?: string | null;
  preferredLanguage?: string;
  workTimeProtection?: string;
  openingBalanceHours?: number | string;
  contractStartDate?: string;
  contractEndDate?: string | null;
  hotelIds?: number[];
  departmentIds?: number[];
  contract?: ContractDto | null;
  pin?: { setAt: string; lockedUntil: string | null; failedCount: number };
  hasBadge?: boolean;
  account?: {
    userId: number;
    username: string | null;
    email: string | null;
    status: string;
    lastLoginAt: string | null;
  };
}

export interface LoginResponseDto {
  availableRoles: Array<{
    role: 'superAdmin' | 'admin' | 'manager' | 'employee';
    employeeId?: number;
    companyName?: string;
    companyIds?: number[];
    hotelNames?: string[];
  }>;
  displayName?: string;
  /** present when the account has exactly one role and needs no further step */
  accessToken?: string;
  /** otherwise: short-lived token for role selection / two-factor setup */
  preToken?: string;
  twoFactorSetupRequired?: boolean;
}
export interface SessionDto {
  accessToken: string;
  role: 'superAdmin' | 'admin' | 'manager' | 'employee';
  employeeId: number | null;
}
export interface TwoFactorSetupDto {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

export interface ExitStatementDto {
  employeeId: number;
  name: string;
  personnelNumber: string;
  lastDay: string;
  reason: string | null;
  vacation: { year: number; remainingDays: number; payoutDays: number };
  timeAccountHours: number | null;
  open: {
    pendingTimeRecords: number;
    openTimeRecords: number;
    pendingCorrections: number;
    pendingAbsenceRequests: number;
    plannedShiftsAfterLastDay: number;
  };
}

/** A rule finding as the planning API reports it. */
export interface ViolationDto {
  code: string;
  severity: 'block' | 'needs_reason' | 'warn';
  message?: string;
  details?: Record<string, unknown>;
}
export interface MyOpenShiftDto extends OpenShiftDto {
  shiftName: string | null;
  warnings: string[];
  claim: { id: number; status: string } | null;
}
export interface TeamAbsenceItemDto {
  displayName: string | null;
  from: string;
  to: string;
}
export interface StaffingSuggestionDto {
  date: string;
  shiftId: number;
  shiftName?: string;
  occupancyPct: number;
  suggested: number;
  required: number;
  planned: number;
  deltaToRequired: number;
  gap: number;
}

export interface ColleagueShiftDto {
  id: number;
  date: string;
  start: string;
  end: string;
  shiftName: string | null;
}
export interface AttendanceHistoryEntryDto {
  at: string | null;
  by: string;
  change: string;
  old: unknown;
  new: unknown;
  reason: string | null;
}

export interface LiveLateDto {
  entryId: number;
  hotelId: number;
  employeeId: number;
  displayName: string | null;
  departmentName: string | null;
  plannedStart: string;
  plannedEnd: string;
  minutesLate: number;
}
export interface LiveNeedsReviewDto {
  punchRecordId: number;
  hotelId: number;
  employeeId: number;
  displayName: string | null;
  departmentName: string | null;
  since: string;
  plannedEnd: string | null;
  reason: 'past_planned_end' | 'unplanned_long';
  openMinutes: number;
}
export interface FeedCommentDto {
  id: number;
  author: string;
  body: string;
  createdAt: string | null;
  canDelete: boolean;
}
export interface RestCompensationRowDto {
  employeeId: number;
  displayName: string;
  shortenedFrom: string;
  shortenedTo: string;
  gapMinutes: number;
  dueBy: string;
  compensatedOn: string | null;
  status: 'ok' | 'open' | 'overdue';
}

export interface SsoProviderDto {
  companyId: number;
  configured?: boolean;
  issuer?: string;
  clientId?: string;
  enabled?: boolean;
  redirectUri: string;
}
/** Structured rule of an hour category (see the rule editor). */
export interface HourCategoryRule {
  daily?: { from: string; to: string };
  weekday?: number;
  holiday?: boolean;
  dates?: string[];
  from?: string;
  to?: string;
}

export interface OpenShiftClaimDto {
  id: number;
  employeeId: number;
  displayName: string | null;
  status: string;
}
export interface OpenShiftWithClaimsDto extends OpenShiftDto {
  claims: OpenShiftClaimDto[];
}
export interface PunchHotelDto {
  hotelId: number;
  name: string;
  breakMode: string;
  networkOk: boolean;
}
export type FeaturesDto = Record<string, boolean>;

export interface WishWho {
  employeeId: number;
  displayName: string | null;
}
export type WishListItemDto =
  | (LeaveWishDto & WishWho & { type: 'leave' })
  | (ShiftWishDto & WishWho & { type: 'shift'; shiftName: string | null });
export interface GridAbsenceDto {
  id: number;
  employeeId: number;
  displayName: string | null;
  type: string;
  from: string;
  to: string;
  status: string;
  days: number | string;
}
export interface CandidateDto {
  employeeId: number;
  displayName: string | null;
  hotelName: string;
  isFloater: boolean;
  weekHours: number;
  targetHours: number | null;
  /** at least one finding blocks the assignment */
  blocked: boolean;
  warnings: ViolationDto[];
}
export interface ValidateResultDto {
  status: 'ok' | 'needs_reason' | 'blocked';
  violations: ViolationDto[];
  totals: unknown[];
}
export interface CopyWeekResultDto {
  created: number;
  skipped: Array<{ entryId: number; reason: string }>;
}

export interface SlotDto {
  id: number;
  date: string;
  start: string;
  end: string;
  shiftName: string | null;
  employeeId: number;
}

export interface LiveClockedInDto {
  punchRecordId: number;
  hotelId: number;
  employeeId: number;
  displayName: string | null;
  departmentName: string | null;
  since: string;
  plannedEnd: string | null;
  flags: string[];
}

export interface WebauthnKeyDto {
  id: number;
  name: string;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}
