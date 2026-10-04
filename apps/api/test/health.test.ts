import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ logger: false, config: { DATABASE_URL: process.env.DATABASE_URL } });
});
afterAll(async () => app.close());

describe('health', () => {
  it('GET /api/v1/health returns 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
  it('unknown route returns error body', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
