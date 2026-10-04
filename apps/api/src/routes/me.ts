import type { FastifyInstance } from 'fastify';
import { getPrincipal, requireRole } from '../lib/auth';
import { loadAvailableRoles } from '../services/accounts';

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', { preHandler: requireRole('ANY') }, async (req) => {
    const p = getPrincipal(req);
    const u = await app.db
      .selectFrom('user_account')
      .select(['id', 'email', 'username', 'last_login_at', 'totp_enabled'])
      .where('id', '=', p.userId)
      .executeTakeFirstOrThrow();
    const { roles, name } = await loadAvailableRoles(app.db, p.userId);
    const out: Record<string, unknown> = {
      userId: u.id,
      email: u.email,
      username: u.username,
      role: p.role,
      displayName: name,
      employeeId: p.employeeId,
      companyIds: p.scope.companyIds,
      hotelIds: p.scope.hotelIds,
      totpEnabled: u.totp_enabled,
      availableRoles: roles,
    };
    if (p.role === 'employee' && p.employeeId) {
      const e = await app.db
        .selectFrom('employee as e')
        .innerJoin('hotel as h', 'h.id', 'e.primary_hotel_id')
        .innerJoin('company as c', 'c.id', 'e.company_id')
        .select([
          'e.first_name',
          'e.last_name',
          'e.display_name',
          'e.personnel_number',
          'h.name as hotel_name',
          'c.name as company_name',
        ])
        .where('e.employee_id', '=', p.employeeId)
        .executeTakeFirstOrThrow();
      out.displayName = `${e.first_name} ${e.last_name}`;
      out.personnelNumber = e.personnel_number;
      out.homeHotel = e.hotel_name;
      out.companyName = e.company_name;
    }
    return out;
  });
}
