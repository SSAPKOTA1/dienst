import type { FastifyRequest } from 'fastify';
import type { Feature } from '@dienst/shared';
import type { DbOrTrx } from '../db';
import { AppError } from '../lib/errors';
import { getPrincipal } from '../lib/auth';

export async function featureEnabled(db: DbOrTrx, companyId: number, feature: Feature): Promise<boolean> {
  const r = await db
    .selectFrom('company_feature')
    .select('enabled')
    .where('company_id', '=', companyId)
    .where('feature', '=', feature)
    .executeTakeFirst();
  return r ? r.enabled : true;
}

/** preHandler for employee endpoints: 403 `FEATURE_DISABLED` when the company switched the feature off. */
export const requireFeature =
  (db: DbOrTrx, feature: Feature) =>
  async (req: FastifyRequest): Promise<void> => {
    const p = getPrincipal(req);
    const ids = p.employeeId
      ? [
          (
            await db
              .selectFrom('employee')
              .select('company_id')
              .where('employee_id', '=', p.employeeId)
              .executeTakeFirstOrThrow()
          ).company_id,
        ]
      : p.scope.companyIds;
    for (const c of ids)
      if (!(await featureEnabled(db, c, feature)))
        throw new AppError('FEATURE_DISABLED', 'This feature is switched off', { feature });
  };
