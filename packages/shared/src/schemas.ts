import { z } from 'zod';

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm');
export const idSchema = z.coerce.number().int().positive();
export const idList = z
  .union([z.string(), z.array(z.coerce.number())])
  .transform((v) =>
    Array.isArray(v)
      ? v.map(Number)
      : v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map(Number),
  )
  .pipe(z.array(z.number().int().positive()));
