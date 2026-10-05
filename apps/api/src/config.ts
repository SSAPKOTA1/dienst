import { z } from 'zod';
import { parseTrustProxy, type TrustProxy } from './lib/proxy';

const schema = z.object({
  DATABASE_URL: z.string().default('postgres://dienst:dienst@localhost:5432/dienst'),
  JWT_SECRET: z.string().min(32).default('dev-only-secret-change-me-please-0123456789'),
  /** previous signing secrets (comma separated): tokens signed with them stay valid while rotating */
  JWT_SECRET_PREVIOUS: z.string().optional(),
  /** master key (64 hex) for data at rest; purpose keys are derived from it */
  DATA_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'DATA_KEY must be 64 hex characters')
    .default('f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f'),
  DATA_KEY_PREVIOUS: z.string().optional(),
  /** legacy raw key that data was encrypted with before DATA_KEY existed; only used to read old data */
  TOTP_ENC_KEY: z.string().length(64).optional(),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  MAIL_FROM: z.string().default('Dienstplan <noreply@dienst.local>'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  API_PORT: z.coerce.number().default(3000),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.string().default('info'),
  MAIL_MODE: z.enum(['smtp', 'json']).default('smtp'),
  RATE_LIMIT_AUTH: z.coerce.number().default(10),
  RATE_LIMIT_KIOSK: z.coerce.number().default(60),
  /** requests per minute and client for every other route */
  RATE_LIMIT_GLOBAL: z.coerce.number().default(600),
  /**
   * Whose X-Forwarded-For to believe: false (default), the number of reverse proxies in front (e.g. 1), or
   * their addresses/CIDR ranges. See lib/proxy.ts. `true` is refused in production.
   */
  TRUST_PROXY: z.string().optional(),
  NODE_ENV: z.string().default('development'),
  /**
   * Whether the server may call private and loopback addresses when it fetches an administrator-supplied
   * URL (SSO). Default: only outside production. Set to true in production only for an identity provider
   * inside the same network, and know that this widens what an administrator can make the server reach.
   */
  OUTBOUND_ALLOW_PRIVATE: z.enum(['true', 'false']).optional(),
});

type Parsed = z.infer<typeof schema>;
export type Config = Omit<Parsed, 'OUTBOUND_ALLOW_PRIVATE' | 'TRUST_PROXY'> & {
  OUTBOUND_ALLOW_PRIVATE: boolean;
  TRUST_PROXY: TrustProxy;
};

const DEV_SECRETS = new Set([
  'dev-only-secret-change-me-please-0123456789',
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f',
]);

const DEV_LEGACY_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = schema.parse(env);
  if (cfg.NODE_ENV === 'production') {
    if (
      DEV_SECRETS.has(cfg.JWT_SECRET) ||
      DEV_SECRETS.has(cfg.DATA_KEY) ||
      (cfg.TOTP_ENC_KEY && DEV_SECRETS.has(cfg.TOTP_ENC_KEY))
    )
      throw new Error(
        'Refusing to start in production with a development JWT_SECRET / DATA_KEY / TOTP_ENC_KEY',
      );
    // the keys must be independent: one leaked value must not open the other area
    if (cfg.TOTP_ENC_KEY && cfg.DATA_KEY.toLowerCase() === cfg.TOTP_ENC_KEY.toLowerCase())
      throw new Error('DATA_KEY must differ from the legacy TOTP_ENC_KEY');
    if (cfg.JWT_SECRET.toLowerCase() === cfg.DATA_KEY.toLowerCase())
      throw new Error('JWT_SECRET and DATA_KEY must be different values');
    if (!cfg.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
  } else if (!cfg.TOTP_ENC_KEY) {
    cfg.TOTP_ENC_KEY = DEV_LEGACY_KEY; // development databases written before DATA_KEY existed stay readable
  }
  return {
    ...cfg,
    TRUST_PROXY: parseTrustProxy(cfg.TRUST_PROXY, cfg.NODE_ENV === 'production'),
    OUTBOUND_ALLOW_PRIVATE:
      (cfg.OUTBOUND_ALLOW_PRIVATE ?? (cfg.NODE_ENV === 'production' ? 'false' : 'true')) === 'true',
  };
}
