import type { Violation } from './util';

export interface GridEntry {
  id: number;
  version: number;
  hotelId: number;
  employeeId: number;
  displayName: string;
  shiftId: number | null;
  shiftName: string | null;
  departmentId: number | null;
  date: string;
  start: string;
  end: string;
  breakMinutes: number;
  hours: number;
  status: 'draft' | 'published' | 'cancelled';
  change: 'new' | 'changed' | 'removed' | null;
  warnings: Violation[];
  isOtherHotel?: boolean;
  otherHotelName?: string;
  readOnly?: boolean;
}

export interface GridCell {
  date: string;
  locked: 'past' | 'closed' | null;
  entries: GridEntry[];
  absenceIds?: number[];
  required?: number;
  assigned?: number;
  open?: number;
}

export interface GridRow {
  key: string;
  kind: 'employee' | 'shift' | 'adhoc';
  employeeId?: number;
  shiftId?: number | null;
  label: string;
  name?: string;
  startTime?: string;
  endTime?: string;
  personnelNumber?: string | null;
  isMinor?: boolean;
  isFloater?: boolean;
  homeHotel?: { id: number; name: string };
  isOtherHotel?: boolean;
  hotelId: number | null;
  hotelName?: string;
  departmentId: number | null;
  departmentName: string;
  reduced?: boolean;
  targetHours?: number | null;
  creditHours?: number | null;
  totalHours: number;
  openSlots?: number;
  cells: GridCell[];
}

export interface GridAbsence {
  id: number;
  employeeId: number;
  displayName: string;
  type: string;
  from: string;
  to: string;
  status: string;
  days: number;
}

export interface Change {
  entryId: number;
  type: 'new' | 'changed' | 'removed';
  employeeId: number;
  displayName: string;
  hotelId: number;
  date: string;
  from: { employeeId: number; date: string; start: string; end: string; breakMinutes: number } | null;
  to: { employeeId: number; date: string; start: string; end: string; breakMinutes: number } | null;
}

export interface Coverage {
  hotelId: number;
  departmentId: number;
  departmentName: string;
  date: string;
  assigned: number;
  required: number;
  underStaffed: boolean;
}

export interface GridData {
  hotelIds: number[];
  view: 'employee' | 'shift';
  range: 'week' | 'month';
  from: string;
  to: string;
  status: 'draft' | 'published';
  days: Array<{ date: string; holiday: string | null; past: boolean; closedHotelIds: number[] }>;
  rows: GridRow[];
  absences: GridAbsence[];
  totals: { perDay: Array<{ date: string; hours: number; headcount: number }> };
  changes: Change[];
  counts: { drafts: number; warnings: number; underStaffed: number; openRequests: number };
  coverage: Coverage[];
}

export interface ShiftTpl {
  id: number;
  hotelId: number;
  departmentId: number;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
}

export type Sel =
  | { kind: 'entry'; id: number }
  | { kind: 'cell'; rowKey: string; date: string }
  | { kind: 'absence'; id: number }
  | null;

export type DropState = 'ok' | 'needs_reason' | 'blocked' | 'pending';

export interface PlanOp {
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Record<string, any>;
  /** label for toasts */
  done?: string;
}
