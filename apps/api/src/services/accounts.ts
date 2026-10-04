import type { FastifyInstance } from 'fastify';
import type { DbOrTrx, Trx } from '../db';
import { sha256, randomToken, randomActivationCode } from '../lib/security';
import { invitationMail } from '../lib/mail';

export interface AvailableRole {
  role: 'superAdmin' | 'admin' | 'manager' | 'employee';
  employeeId?: number;
  companyName?: string;
  companyIds?: number[];
  hotelNames?: string[];
}

export async function loadAvailableRoles(
  db: DbOrTrx,
  userId: number,
): Promise<{ roles: AvailableRole[]; name: string }> {
  const roles: AvailableRole[] = [];
  let name = '';
  const sa = await db.selectFrom('super_admin').selectAll().where('user_id', '=', userId).executeTakeFirst();
  if (sa) {
    roles.push({ role: 'superAdmin' });
    name ||= `${sa.first_name} ${sa.last_name}`;
  }
  const ad = await db.selectFrom('admin').selectAll().where('user_id', '=', userId).executeTakeFirst();
  if (ad) {
    const cs = await db
      .selectFrom('admin_company as ac')
      .innerJoin('company as c', 'c.id', 'ac.company_id')
      .select(['c.id', 'c.name'])
      .where('ac.admin_id', '=', ad.admin_id)
      .execute();
    roles.push({
      role: 'admin',
      companyIds: cs.map((c) => c.id),
      companyName: cs.map((c) => c.name).join(', '),
    });
    name ||= `${ad.first_name} ${ad.last_name}`;
  }
  const mg = await db.selectFrom('manager').selectAll().where('user_id', '=', userId).executeTakeFirst();
  if (mg) {
    const hs = await db
      .selectFrom('manager_hotel as mh')
      .innerJoin('hotel as h', 'h.id', 'mh.hotel_id')
      .select('h.name')
      .where('mh.manager_id', '=', mg.manager_id)
      .execute();
    roles.push({ role: 'manager', hotelNames: hs.map((h) => h.name) });
    name ||= `${mg.first_name} ${mg.last_name}`;
  }
  const emps = await db
    .selectFrom('employee as e')
    .innerJoin('company as c', 'c.id', 'e.company_id')
    .select(['e.employee_id', 'e.first_name', 'e.last_name', 'c.name as company_name'])
    .where('e.user_id', '=', userId)
    .where('e.status', '=', 'active')
    .orderBy('e.employee_id')
    .execute();
  for (const e of emps) {
    roles.push({ role: 'employee', employeeId: e.employee_id, companyName: e.company_name });
    name ||= `${e.first_name} ${e.last_name}`;
  }
  return { roles, name };
}

export type InvitationMethod = 'email' | 'code';

/** Sets a fresh invitation (24 h link token) or one-time activation code (7 days). Returns the plaintext once. */
export async function issueInvitation(
  trx: DbOrTrx,
  userId: number,
  method: InvitationMethod,
  now: Date,
): Promise<{ secret: string; expiresAt: Date }> {
  const secret = method === 'email' ? randomToken() : randomActivationCode();
  const expiresAt = new Date(now.getTime() + (method === 'email' ? 24 * 3600e3 : 7 * 24 * 3600e3));
  await trx
    .updateTable('user_account')
    .set({ invitation_token_hash: sha256(secret), invitation_expires_at: expiresAt, updated_at: now })
    .where('id', '=', userId)
    .execute();
  return { secret, expiresAt };
}

export async function sendInvitationMail(
  app: FastifyInstance,
  to: string,
  name: string,
  token: string,
): Promise<void> {
  await app.mailer.send(invitationMail(to, name, `${app.cfg.WEB_ORIGIN}/accept-invitation?token=${token}`));
}

export type { Trx };
