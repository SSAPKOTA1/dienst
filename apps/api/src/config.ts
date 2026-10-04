import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().default('postgres://dienst:dienst@localhost:5432/dienst'),
  JWT_SECRET: z.string().min(32).default('dev-only-secret-change-me-please-0123456789'),
  TOTP_ENC_KEY: z
    .string()
    .length(64)
    .default('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
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
  /** set to 1 behind a reverse proxy so the client IP (rate limits, audit log) is read from X-Forwarded-For */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  NODE_ENV: z.string().default('development'),
});

export type Config = z.infer<typeof schema>;

const DEV_SECRETS = new Set([
  'dev-only-secret-change-me-please-0123456789',
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = schema.parse(env);
  if (cfg.NODE_ENV === 'production') {
    if (DEV_SECRETS.has(cfg.JWT_SECRET) || DEV_SECRETS.has(cfg.TOTP_ENC_KEY))
      throw new Error('Refusing to start in production with the development JWT_SECRET / TOTP_ENC_KEY');
    if (!cfg.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
  }
  return cfg;
}
