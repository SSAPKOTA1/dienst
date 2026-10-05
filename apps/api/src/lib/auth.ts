import type { FastifyReply, FastifyRequest, preValidationAsyncHookHandler } from 'fastify';
import type { Role } from '@dienst/shared';
import { AppError } from './errors';
import { verifyToken } from './jwt';
import { buildPrincipal, roleToActorType, type Principal } from './scope';
import type { Actor } from './audit';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    preUserId: number | null;
    preSsoMfa: boolean;
  }
}

interface Cached {
  until: number;
  principal: Principal;
}
const principalCache = new WeakMap<object, Map<string, Cached>>();

/**
 * Scope + account status of a token holder. The lookup runs on every request, so a short cache
 * (PRINCIPAL_CACHE_MS) saves about five queries per call; a revoked role or blocked account is
 * noticed after at most that long. Deactivation by password reset or logout also revokes the refresh token.
 */
async function resolvePrincipal(
  app: FastifyRequest['server'],
  userId: number,
  role: Role,
  employeeId?: number | null,
): Promise<Principal> {
  const ttl = app.cfg.PRINCIPAL_CACHE_MS;
  const key = `${userId}:${role}:${employeeId ?? ''}`;
  let cache = principalCache.get(app);
  if (!cache) principalCache.set(app, (cache = new Map()));
  const hit = cache.get(key);
  if (ttl > 0 && hit && hit.until > Date.now()) return hit.principal;
  const principal = await buildPrincipal(app.db, userId, role, employeeId);
  if (!principal) throw new AppError('UNAUTHENTICATED', 'Role is no longer available');
  const user = await app.db
    .selectFrom('user_account')
    .select('status')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user || user.status !== 'active') throw new AppError('UNAUTHENTICATED', 'Account is not active');
  if (ttl > 0) {
    if (cache.size > 5000) cache.clear();
    cache.set(key, { until: Date.now() + ttl, principal });
  } else cache.delete(key);
  return principal;
}

export type RoleSpec = Role | 'ANY';

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7);
}

/** Authenticates the request and checks the role. `ANY` accepts every authenticated role. */
export function requireRole(...roles: RoleSpec[]): preValidationAsyncHookHandler {
  return async function (req: FastifyRequest, _reply: FastifyReply) {
    const app = req.server;
    const tok = bearer(req);
    if (!tok) throw new AppError('UNAUTHENTICATED', 'Missing access token');
    const claims = await verifyToken<{ role?: Role; pre?: boolean; employeeId?: number }>(
      app.keys.verifying('access'),
      tok,
    );
    if (!claims || claims.pre || !claims.role)
      throw new AppError('UNAUTHENTICATED', 'Invalid or expired token');
    const principal = await resolvePrincipal(app, Number(claims.sub), claims.role, claims.employeeId);
    if (!roles.includes('ANY') && !roles.includes(principal.role)) {
      throw new AppError('FORBIDDEN_SCOPE', 'This role may not use this endpoint');
    }
    req.principal = principal;
  };
}

/** Accepts the short-lived pre-role token (after password check, before role selection) or a normal token. */
export const requirePreOrAccess: preValidationAsyncHookHandler = async (req) => {
  const app = req.server;
  const tok = bearer(req);
  if (!tok) throw new AppError('UNAUTHENTICATED', 'Missing token');
  const claims = await verifyToken<{ role?: Role; pre?: boolean; employeeId?: number; ssoMfa?: boolean }>(
    app.keys.verifying('access'),
    tok,
  );
  // only real session tokens: other signed payloads (kiosk refs, SSO tickets) carry neither a role nor `pre`
  if (!claims || !claims.sub || (!claims.pre && !claims.role))
    throw new AppError('UNAUTHENTICATED', 'Invalid or expired token');
  req.preUserId = Number(claims.sub);
  req.preSsoMfa = claims.ssoMfa === true;
  if (claims.role && !claims.pre) {
    req.principal = await buildPrincipal(app.db, Number(claims.sub), claims.role, claims.employeeId);
  }
};

export const getPrincipal = (req: FastifyRequest): Principal => {
  if (!req.principal) throw new AppError('UNAUTHENTICATED', 'Not authenticated');
  return req.principal;
};

export const actorOf = (req: FastifyRequest): Actor => ({
  userId: req.principal?.userId ?? req.preUserId ?? null,
  type: req.principal ? roleToActorType(req.principal.role) : 'system',
  ip: req.ip,
  userAgent: req.headers['user-agent']?.slice(0, 300),
});
