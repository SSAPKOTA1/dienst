import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Trx } from '../db';
import { AppError, notFound } from '../lib/errors';
import { actorOf, getPrincipal, requireRole } from '../lib/auth';
import { audit } from '../lib/audit';
import { staffRolesOf, setAdminAccess } from '../services/roles';

const SA = 'superAdmin' as const;
const userIdParam = z.object({ userId: z.coerce.number().int().positive() });
const ids = z.array(z.number().int().positive());

/**
 * Staff roles of one person (super admin only). A person may hold several roles; they never combine, the user picks
 * one at login. The employee role is not handled here: it follows onboarding and offboarding of the employee.
 * Revoking keeps the row (other records point at it) and sets revoked_at.
 */
export async function roleRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const tx = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);

  r.get(
    '/users/:userId/roles',
    { preValidation: requireRole(SA), schema: { params: userIdParam } },
    async (req) => {
      const roles = await staffRolesOf(db, req.params.userId);
      if (!roles) throw notFound('User');
      return roles;
    },
  );

  const body = z.object({
    superAdmin: z.boolean().optional(),
    /** null removes the role; an object grants it or replaces its access; omitted leaves it as it is */
    admin: z.object({ companyIds: ids, hotelIds: ids }).nullable().optional(),
    manager: z
      .object({ hotelIds: ids.min(1) })
      .nullable()
      .optional(),
  });

  r.put(
    '/users/:userId/roles',
    { preValidation: requireRole(SA), schema: { params: userIdParam, body } },
    async (req) => {
      const p = getPrincipal(req);
      const b = req.body;
      const userId = req.params.userId;
      const now = app.clock();
      return tx(async (trx) => {
        const before = await staffRolesOf(trx, userId);
        if (!before) throw notFound('User');

        const wantsRole = b.superAdmin === true || !!b.admin || !!b.manager;
        let first = '';
        let last = '';
        if (wantsRole) {
          // staff roles need an e-mail address (login and invitation); an employee's contact address is used when the account has none
          if (!before.email) {
            const emp = await trx
              .selectFrom('employee')
              .select('contact_email')
              .where('user_id', '=', userId)
              .where('status', '=', 'active')
              .executeTakeFirst();
            const mail = emp?.contact_email?.trim();
            if (!mail)
              throw new AppError(
                'VALIDATION',
                'This person needs an e-mail address before getting a staff role',
              );
            const taken = await trx
              .selectFrom('user_account')
              .select('id')
              .where((eb) => eb(eb.fn('lower', ['email']), '=', mail.toLowerCase()))
              .executeTakeFirst();
            if (taken) throw new AppError('CONFLICT', 'This e-mail address belongs to another account');
            await trx
              .updateTable('user_account')
              .set({ email: mail, updated_at: now })
              .where('id', '=', userId)
              .execute();
          }
          [first, last] = [before.name.split(' ')[0] ?? '', before.name.split(' ').slice(1).join(' ')];
        }

        // ---- super admin
        if (b.superAdmin !== undefined && b.superAdmin !== before.superAdmin) {
          if (b.superAdmin) {
            const row = await trx
              .selectFrom('super_admin')
              .select('super_admin_id')
              .where('user_id', '=', userId)
              .executeTakeFirst();
            if (row)
              await trx
                .updateTable('super_admin')
                .set({ revoked_at: null, updated_at: now })
                .where('super_admin_id', '=', row.super_admin_id)
                .execute();
            else
              await trx
                .insertInto('super_admin')
                .values({ user_id: userId, first_name: first, last_name: last })
                .execute();
          } else {
            if (userId === p.userId)
              throw new AppError('FORBIDDEN_SCOPE', 'You cannot remove your own super admin role');
            const others = await trx
              .selectFrom('super_admin')
              .select('super_admin_id')
              .where('revoked_at', 'is', null)
              .where('user_id', '!=', userId)
              .executeTakeFirst();
            if (!others) throw new AppError('CONFLICT', 'There must always be at least one super admin');
            await trx
              .updateTable('super_admin')
              .set({ revoked_at: now, updated_at: now })
              .where('user_id', '=', userId)
              .execute();
          }
        }

        // ---- admin
        if (b.admin === null && before.admin) {
          const row = await trx
            .selectFrom('admin')
            .select('admin_id')
            .where('user_id', '=', userId)
            .executeTakeFirstOrThrow();
          await trx
            .updateTable('admin')
            .set({ revoked_at: now, updated_at: now })
            .where('admin_id', '=', row.admin_id)
            .execute();
          await trx.deleteFrom('admin_company').where('admin_id', '=', row.admin_id).execute();
          await trx.deleteFrom('admin_hotel').where('admin_id', '=', row.admin_id).execute();
        } else if (b.admin) {
          if (!b.admin.companyIds.length && !b.admin.hotelIds.length)
            throw new AppError('VALIDATION', 'Assign at least one company or hotel to the admin');
          let row = await trx
            .selectFrom('admin')
            .select('admin_id')
            .where('user_id', '=', userId)
            .executeTakeFirst();
          if (row)
            await trx
              .updateTable('admin')
              .set({ revoked_at: null, updated_at: now })
              .where('admin_id', '=', row.admin_id)
              .execute();
          else
            row = await trx
              .insertInto('admin')
              .values({ user_id: userId, first_name: first, last_name: last, created_by_id: p.superAdminId! })
              .returning('admin_id')
              .executeTakeFirstOrThrow();
          await setAdminAccess(trx, row.admin_id, b.admin.companyIds, b.admin.hotelIds, p.superAdminId!);
        }

        // ---- manager
        if (b.manager === null && before.manager) {
          const row = await trx
            .selectFrom('manager')
            .select('manager_id')
            .where('user_id', '=', userId)
            .executeTakeFirstOrThrow();
          await trx
            .updateTable('manager')
            .set({ revoked_at: now, updated_at: now })
            .where('manager_id', '=', row.manager_id)
            .execute();
          await trx.deleteFrom('manager_hotel').where('manager_id', '=', row.manager_id).execute();
        } else if (b.manager) {
          for (const h of b.manager.hotelIds)
            if (!(await trx.selectFrom('hotel').select('id').where('id', '=', h).executeTakeFirst()))
              throw notFound('Hotel');
          let row = await trx
            .selectFrom('manager')
            .select('manager_id')
            .where('user_id', '=', userId)
            .executeTakeFirst();
          if (row)
            await trx
              .updateTable('manager')
              .set({ revoked_at: null, updated_at: now })
              .where('manager_id', '=', row.manager_id)
              .execute();
          else
            row = await trx
              .insertInto('manager')
              .values({ user_id: userId, first_name: first, last_name: last, created_by_id: p.adminId })
              .returning('manager_id')
              .executeTakeFirstOrThrow();
          await trx.deleteFrom('manager_hotel').where('manager_id', '=', row.manager_id).execute();
          await trx
            .insertInto('manager_hotel')
            .values(b.manager.hotelIds.map((h) => ({ manager_id: row!.manager_id, hotel_id: h })))
            .execute();
        }

        const after = (await staffRolesOf(trx, userId))!;
        await audit(trx, actorOf(req), {
          action: 'staff_roles_updated',
          entityType: 'user_account',
          entityId: userId,
          old: { superAdmin: before.superAdmin, admin: before.admin, manager: before.manager },
          new: { superAdmin: after.superAdmin, admin: after.admin, manager: after.manager },
        });
        return after;
      });
    },
  );
}
