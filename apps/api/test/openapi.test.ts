import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, loginAs, makeSuperAdmin, startApp, stopApp, type TestCtx } from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await startApp();
  await makeSuperAdmin(ctx.db);
});
afterAll(async () => stopApp(ctx));

describe('internal OpenAPI', () => {
  it('needs an admin token', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(401);
  });
  it('describes the routes with their request schemas', async () => {
    const token = await loginAs(ctx, 'sa@test.dev', 'superAdmin');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.0.3');
    const paths = Object.keys(doc.paths);
    expect(paths.length).toBeGreaterThan(150);
    expect(paths).toContain('/api/v1/auth/login');
    expect(doc.paths['/api/v1/auth/login'].post.requestBody).toBeTruthy();
  });
});
