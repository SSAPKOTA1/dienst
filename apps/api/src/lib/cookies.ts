import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Cookie names and attributes. Over https the names carry the `__Secure-` prefix, so a browser refuses to
 * store them unless they were set with the Secure attribute from a secure origin (a plain-http response, or an
 * attacker on a sibling host, cannot plant or overwrite them). Plain names remain for http development.
 * `__Host-` would be stricter still but needs `Path=/`; these cookies are deliberately limited to their API paths.
 */
export const cookieName = (secure: boolean, base: string): string => (secure ? `__Secure-${base}` : base);

/** Reads the cookie; while sessions from before the prefix exist the plain name is accepted as well. */
export function readCookie(req: FastifyRequest, secure: boolean, base: string): string | undefined {
  return req.cookies[cookieName(secure, base)] ?? (secure ? req.cookies[base] : undefined);
}

export function writeCookie(
  reply: FastifyReply,
  secure: boolean,
  base: string,
  value: string,
  opts: { path: string; maxAge: number; sameSite: 'lax' | 'strict' },
) {
  reply.setCookie(cookieName(secure, base), value, {
    httpOnly: true,
    secure,
    sameSite: opts.sameSite,
    path: opts.path,
    maxAge: opts.maxAge,
  });
  // a cookie from before the prefix must not linger next to the new one
  if (secure) reply.clearCookie(base, { path: opts.path });
}

export function removeCookie(reply: FastifyReply, secure: boolean, base: string, path: string) {
  reply.clearCookie(cookieName(secure, base), { path, secure, httpOnly: true });
  if (secure) reply.clearCookie(base, { path });
}
