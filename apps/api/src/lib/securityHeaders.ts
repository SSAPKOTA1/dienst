import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';

/**
 * Security headers of the API. It only returns JSON, files and redirects, never pages, so the
 * policy forbids everything: no scripts, no framing, no base URI, no form targets.
 * HSTS is sent only in production (a development server on localhost must not pin https).
 */
export async function registerSecurityHeaders(app: FastifyInstance, production: boolean) {
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    strictTransportSecurity: production ? { maxAge: 63072000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    xFrameOptions: { action: 'deny' },
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    // browser features the app never needs; location and camera in particular (no GPS, no biometrics)
    reply.header(
      'permissions-policy',
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
    );
    // answers contain personal data, one-time credentials or tokens: never store them in a shared cache
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });
}
