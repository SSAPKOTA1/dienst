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
});

export type Config = z.infer<typeof schema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => schema.parse(env);
