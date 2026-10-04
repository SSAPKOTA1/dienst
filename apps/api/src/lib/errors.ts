import { ERROR_STATUS, type ErrorCode } from '@dienst/shared';

export class AppError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message ?? code);
    this.statusCode = ERROR_STATUS[code];
  }
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`);
export const forbidden = (msg = 'Not allowed for this scope') => new AppError('FORBIDDEN_SCOPE', msg);
export const validation = (msg: string, details: Record<string, unknown> = {}) =>
  new AppError('VALIDATION', msg, details);
