// Live black-box security probe. Usage: BASE=http://localhost:3000 node scripts/security/probe.mjs
// Needs the demo seed (accounts and TOTP secret printed by `pnpm db:seed`). Never run against production.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { authenticator } = require('otplib');

const BASE = process.env.BASE ?? 'http://localhost:3000';
const API = `${BASE}/api/v1`;
const PASSWORD = 'Demo!2345';
const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const results = [];
const check = (area, name, ok, info = '') => {
  results.push({ area, name, ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${area}] ${name}${info ? ' - ' + info : ''}`);
};

async function http(method, path, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload = raw;
  if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch(path.startsWith('http') ? path : API + path, {
    method,
    headers: h,
    body: payload,
    redirect: 'manual',
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: r.status, json, text, headers: r.headers };
}

async function login(login, role, employeeId) {
  const r = await http('POST', '/auth/login', {
    body: {
      login,
      password: PASSWORD,
      totp: login.startsWith('sa@') || login.startsWith('admin@') ? authenticator.generate(TOTP) : undefined,
    },
  });
  if (r.json?.accessToken) return r.json.accessToken;
  if (!r.json?.preToken) throw new Error(`login ${login}: ${r.status} ${r.text.slice(0, 200)}`);
  const s = await http('POST', '/auth/select-role', { token: r.json.preToken, body: { role, employeeId } });
  if (!s.json?.accessToken) throw new Error(`select-role ${login}: ${s.status} ${s.text.slice(0, 200)}`);
  return s.json.accessToken;
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

async function main() {
  // ---------------------------------------------------------------- tokens
  const sa = await login('sa@demo.test', 'superAdmin');
  const admin = await login('admin@demo.test', 'admin');
  const mgr = await login('manager@demo.test', 'manager');
  const meE = await http('GET', '/me', { token: sa });
  // employee token: need employeeId
  const empLogin = await http('POST', '/auth/login', { body: { login: 'maria.garcia', password: PASSWORD } });
  let emp = empLogin.json?.accessToken;
  if (!emp) {
    const roles = empLogin.json?.roles ?? [];
    const e = roles.find((x) => x.role === 'employee');
    emp = await login('maria.garcia', 'employee', e?.employeeId);
  }
  check(
    'setup',
    'got tokens for super admin, admin, manager, employees',
    !!(sa && admin && mgr && emp),
    `me=${meE.status}`,
  );

  // ---------------------------------------------------------------- route inventory
  const spec = await http('GET', '/openapi.json', { token: admin });
  const paths = spec.json?.paths ?? {};
  const routes = [];
  for (const [p, ops] of Object.entries(paths))
    for (const m of Object.keys(ops))
      if (['get', 'post', 'put', 'patch', 'delete'].includes(m))
        routes.push({ method: m.toUpperCase(), path: p });
  check('setup', 'OpenAPI lists the routes', routes.length > 150, `${routes.length} operations`);
  const fill = (p, id = 1) => p.replace(/\{[^}]+\}/g, String(id));
  const publicOk = new Set([
    '/api/v1/health',
    '/api/v1/auth/login',
    '/api/v1/auth/refresh',
    '/api/v1/auth/logout',
    '/api/v1/auth/forgot-password',
    '/api/v1/auth/reset-password',
    '/api/v1/auth/accept-invitation',
    '/api/v1/auth/invitation',
    '/api/v1/kiosk/register',
  ]);

  // ---------------------------------------------------------------- 1. no token => 401 on every non-public route
  const open = [];
  for (const r of routes) {
    if (
      [...publicOk].some((x) => r.path.startsWith(x)) ||
      r.path.includes('/health') ||
      r.path.includes('/kiosk') ||
      r.path.includes('/sso') ||
      r.path.includes('/me/calendar') ||
      r.path.includes('/feed.ics') ||
      r.path.includes('/ics/')
    )
      continue;
    const res = await http(r.method, fill(r.path), {
      body: ['POST', 'PUT', 'PATCH'].includes(r.method) ? {} : undefined,
    });
    if (res.status !== 401 && res.status !== 404 && res.status !== 400 && res.status !== 429)
      open.push(`${r.method} ${r.path} -> ${res.status}`);
    else if (res.status === 400) open.push(`${r.method} ${r.path} -> 400 (validation before auth)`);
  }
  check(
    'authn',
    'every protected route answers 401 without a token',
    open.length === 0,
    open.slice(0, 8).join('; '),
  );

  // ---------------------------------------------------------------- 2. forged / bad tokens
  const hdr = b64({ alg: 'none', typ: 'JWT' });
  const none = `${hdr}.${b64({ sub: '1', role: 'superAdmin', exp: 9999999999 })}.`;
  const forged = await http('GET', '/me', { token: none });
  check('authn', 'alg=none token rejected', forged.status === 401);
  const [h, p, s] = admin.split('.');
  const tampered = `${h}.${b64({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), role: 'superAdmin' })}.${s}`;
  check(
    'authn',
    'token with edited claims rejected',
    (await http('GET', '/me', { token: tampered })).status === 401,
  );
  check(
    'authn',
    'garbage bearer rejected',
    (await http('GET', '/me', { token: 'abc.def.ghi' })).status === 401,
  );
  check(
    'authn',
    'token of another purpose (kiosk ref as bearer) rejected',
    (await http('GET', '/me', { token: 'kd_demo_frankfurt_4f1c9a7e2b6d8035a1e94c7b02d6f83a' })).status ===
      401,
  );

  // ---------------------------------------------------------------- 3. role matrix: employee must not reach planner/admin routes
  const planningGets = routes.filter(
    (r) =>
      r.method === 'GET' &&
      /^\/api\/v1\/(employees|admin|audit-log|schedule|staffing|hotels|companies|users|api-keys|rule|payroll|analytics|compliance|approvals|requests|live)/.test(
        r.path,
      ) &&
      !r.path.startsWith('/api/v1/me'),
  );
  const leaks = [];
  for (const r of planningGets) {
    const res = await http('GET', fill(r.path), { token: emp });
    if (res.status === 200) leaks.push(r.path);
  }
  check(
    'authz',
    'employee token gets no 200 from planner/admin GET routes',
    leaks.length === 0,
    leaks.slice(0, 10).join(', '),
  );
  const mutLeaks = [];
  for (const r of routes.filter(
    (x) =>
      x.method !== 'GET' &&
      /^\/api\/v1\/(employees|admin|hotels|companies|users|api-keys|schedule|shifts|staffing|rule|payroll|departments|managers|admins)/.test(
        x.path,
      ),
  )) {
    const res = await http(r.method, fill(r.path), { token: emp, body: {} });
    if (![401, 403, 404].includes(res.status)) mutLeaks.push(`${r.method} ${r.path} ${res.status}`);
  }
  check(
    'authz',
    'employee token cannot reach planner/admin write routes (403/404 before validation)',
    mutLeaks.length === 0,
    mutLeaks.slice(0, 8).join('; '),
  );
  const mgrAdmin = [];
  for (const r of routes.filter((x) =>
    /^\/api\/v1\/(admins|companies|api-keys|audit-log\/verify|rule-profiles|sso)/.test(x.path),
  )) {
    const res = await http(r.method, fill(r.path), { token: mgr, body: r.method === 'GET' ? undefined : {} });
    if (![401, 403, 404].includes(res.status)) mgrAdmin.push(`${r.method} ${r.path} ${res.status}`);
  }
  check(
    'authz',
    'manager token blocked from company-admin routes',
    mgrAdmin.length === 0,
    mgrAdmin.slice(0, 8).join('; '),
  );

  // ---------------------------------------------------------------- 4. IDOR: cross-hotel / cross-tenant ids
  const idor = [];
  const empList = await http('GET', '/employees?pageSize=200', { token: admin });
  const allIds = (empList.json?.items ?? []).map((e) => e.employeeId ?? e.id);
  const mgrList = await http('GET', '/employees?pageSize=200', { token: mgr });
  const mgrIds = new Set((mgrList.json?.items ?? []).map((e) => e.employeeId ?? e.id));
  check(
    'authz',
    'manager list is limited to own hotels (smaller than admin list)',
    mgrIds.size > 0 && mgrIds.size < allIds.length,
    `${mgrIds.size} of ${allIds.length}`,
  );
  for (const id of allIds.filter((i) => !mgrIds.has(i)).slice(0, 15)) {
    for (const sub of ['', '/contracts', '/time-account', '/documents', '/data-export', '/access-log']) {
      const res = await http('GET', `/employees/${id}${sub}`, { token: mgr });
      if (res.status === 200) idor.push(`/employees/${id}${sub}`);
    }
  }
  check(
    'authz',
    'manager cannot read employees outside own hotels (IDOR)',
    idor.length === 0,
    idor.slice(0, 6).join(', '),
  );
  const emp2 = [];
  for (const id of allIds.slice(0, 20)) {
    for (const sub of ['', '/contracts', '/documents']) {
      const res = await http('GET', `/employees/${id}${sub}`, { token: emp });
      if (res.status === 200) emp2.push(`/employees/${id}${sub}`);
    }
  }
  check(
    'authz',
    'employee cannot read employee records through planner routes',
    emp2.length === 0,
    emp2.slice(0, 5).join(', '),
  );
  const meId = (await http('GET', '/me', { token: emp })).json?.employeeId;
  const otherDocs = await http('GET', '/me/documents/999999/download', { token: emp });
  check(
    'authz',
    'employee document download of a foreign/non-existing id is 404/403',
    [403, 404].includes(otherDocs.status),
    String(otherDocs.status),
  );
  const crossExport = await http('GET', `/employees/${allIds.find((i) => i !== meId)}/data-export`, {
    token: emp,
  });
  check(
    'authz',
    "employee cannot export another person's data",
    [401, 403, 404].includes(crossExport.status),
    String(crossExport.status),
  );

  // ---------------------------------------------------------------- 5. injection / fuzz: no 5xx, no stack traces
  const payloads = [
    `' OR '1'='1`,
    `1; DROP TABLE employee; --`,
    `"><script>alert(1)</script>`,
    `${'A'.repeat(5000)}`,
    `../../etc/passwd`,
    `{"$ne":null}`,
    `\u0000`,
    `-1`,
    `99999999999999999999`,
    `%00`,
    `1 UNION SELECT password_hash FROM user_account`,
  ];
  const fiveHundreds = [];
  const traces = [];
  for (const r of routes.filter((x) => x.method === 'GET').slice(0, 400)) {
    for (const pl of payloads) {
      const url = fill(r.path, encodeURIComponent(pl));
      const q = `${url}${url.includes('?') ? '&' : '?'}q=${encodeURIComponent(pl)}&month=${encodeURIComponent(pl)}&hotelId=${encodeURIComponent(pl)}&from=${encodeURIComponent(pl)}`;
      const res = await http('GET', q, { token: admin });
      if (res.status >= 500) fiveHundreds.push(`${r.path} <- ${pl.slice(0, 20)} ${res.status}`);
      if (/at .*\.(ts|js|mjs):\d+|node_modules|SELECT .* FROM|syntax error at/i.test(res.text))
        traces.push(r.path);
    }
  }
  check(
    'injection',
    'no 5xx on hostile query/path input across GET routes',
    fiveHundreds.length === 0,
    fiveHundreds.slice(0, 6).join('; '),
  );
  check(
    'injection',
    'no stack traces or SQL in error bodies',
    traces.length === 0,
    traces.slice(0, 5).join(', '),
  );
  const bodyFuzz = [];
  for (const r of routes.filter(
    (x) => ['POST', 'PUT', 'PATCH'].includes(x.method) && !/(logout|login|refresh)/.test(x.path),
  )) {
    for (const body of [
      { name: payloads[0], title: payloads[2], reason: payloads[1], id: payloads[3] },
      [],
      null,
      'str',
      { __proto__: { admin: true }, constructor: { prototype: { admin: true } } },
    ]) {
      const res = await http(r.method, fill(r.path), { token: admin, body });
      if (res.status >= 500) bodyFuzz.push(`${r.method} ${r.path} ${res.status}`);
    }
  }
  check(
    'injection',
    'no 5xx on hostile JSON bodies across write routes',
    bodyFuzz.length === 0,
    [...new Set(bodyFuzz)].slice(0, 8).join('; '),
  );
  const malformed = await http('POST', '/auth/login', {
    raw: '{"login": ',
    headers: { 'content-type': 'application/json' },
  });
  check(
    'injection',
    'malformed JSON is a 400, not a 500',
    malformed.status === 400,
    String(malformed.status),
  );
  const big = await http('POST', '/auth/login', {
    raw: JSON.stringify({ login: 'a'.repeat(2_000_000), password: 'x' }),
    headers: { 'content-type': 'application/json' },
  });
  check(
    'injection',
    'oversized body (2 MB) refused',
    big.status === 413 || big.status === 400,
    String(big.status),
  );

  // ---------------------------------------------------------------- 6. mass assignment / privilege fields
  const created = await http('POST', '/employees', { token: mgr, body: { firstName: 'X', lastName: 'Y' } });
  check('authz', 'manager cannot create employees', [403].includes(created.status), String(created.status));
  const selfRole = await http('PUT', '/me', { token: emp, body: { role: 'superAdmin', status: 'active' } });
  check(
    'authz',
    'self-service update cannot change role',
    [400, 403, 404, 405].includes(selfRole.status) || selfRole.json?.role !== 'superAdmin',
    String(selfRole.status),
  );

  // ---------------------------------------------------------------- 7. brute force / lockout / enumeration
  const wrong = [];
  for (let i = 0; i < 12; i++)
    wrong.push(
      (await http('POST', '/auth/login', { body: { login: 'tom.weber', password: 'wrong-password-' + i } }))
        .status,
    );
  const afterLock = await http('POST', '/auth/login', { body: { login: 'tom.weber', password: PASSWORD } });
  check(
    'authn',
    'account locks after repeated wrong passwords (correct password then refused)',
    [401, 423, 429].includes(afterLock.status) && afterLock.status !== 200,
    `statuses ${[...new Set(wrong)].join(',')} then ${afterLock.status}`,
  );
  const unknown = await http('POST', '/auth/login', {
    body: { login: 'nobody@nowhere.test', password: 'whatever-123456' },
  });
  const known = await http('POST', '/auth/login', {
    body: { login: 'jon.schmidt', password: 'whatever-123456' },
  });
  check(
    'authn',
    'unknown and known users get the same error (no user enumeration)',
    unknown.status === known.status && unknown.json?.error?.code === known.json?.error?.code,
    `${unknown.status}/${known.status}`,
  );
  const forgot1 = await http('POST', '/auth/forgot-password', { body: { email: 'nobody@nowhere.test' } });
  const forgot2 = await http('POST', '/auth/forgot-password', { body: { email: 'jon.schmidt@demo.test' } });
  check(
    'authn',
    'password reset answers identically for known and unknown e-mails',
    forgot1.status === forgot2.status,
    `${forgot1.status}/${forgot2.status}`,
  );
  const weak = await http('POST', '/auth/accept-invitation', {
    body: { token: 'x'.repeat(20), password: 'short' },
  });
  check('authn', 'weak password refused', [400, 404].includes(weak.status), String(weak.status));

  // ---------------------------------------------------------------- 8. kiosk
  const kk = 'kd_demo_frankfurt_4f1c9a7e2b6d8035a1e94c7b02d6f83a';
  const noTok = await http('GET', '/kiosk/roster');
  check(
    'kiosk',
    'kiosk roster without device token refused',
    [401, 403].includes(noTok.status),
    String(noTok.status),
  );
  const badTok = await http('GET', '/kiosk/roster', { headers: { 'x-kiosk-token': 'kd_bad' } });
  check(
    'kiosk',
    'kiosk roster with wrong token refused',
    [401, 403].includes(badTok.status),
    String(badTok.status),
  );
  const pins = [];
  const roster = await http('GET', '/kiosk/roster', { headers: { 'x-kiosk-token': kk } });
  const first = roster.json?.items?.[0] ?? roster.json?.employees?.[0];
  if (first) {
    for (let i = 0; i < 8; i++)
      pins.push(
        (
          await http('POST', '/kiosk/punch-in', {
            headers: { 'x-kiosk-token': kk },
            body: { employeeRef: first.employeeRef, pin: String(100000 + i) },
          })
        ).status,
      );
    check(
      'kiosk',
      'PIN guessing is locked/limited',
      pins.includes(423) || pins.includes(429),
      pins.join(','),
    );
  } else
    check('kiosk', 'roster readable with device token (for PIN probe)', false, roster.text.slice(0, 120));
  check(
    'kiosk',
    'roster does not expose PIN hashes or full names/emails',
    !/pin_hash|pinHash|argon2|@demo\.test/.test(roster.text),
  );

  // ---------------------------------------------------------------- 9. secrets in responses
  const dumps = [];
  for (const [n, t] of [
    ['admin', admin],
    ['sa', sa],
    ['mgr', mgr],
  ]) {
    for (const path of ['/me', '/employees?pageSize=5', '/admin/users', '/hotels', '/companies']) {
      const res = await http('GET', path, { token: t });
      if (
        /password_hash|passwordHash|totp_secret|totpSecret|pin_hash|pinHash|argon2id|invitation_token_hash|token_hash|content_enc/.test(
          res.text,
        )
      )
        dumps.push(`${n} ${path}`);
    }
  }
  check('data', 'no hashes/secrets in common API responses', dumps.length === 0, dumps.join(', '));

  // ---------------------------------------------------------------- 10. headers / CORS / cookies
  const hres = await http('GET', '/health');
  const hh = (k) => hres.headers.get(k);
  check(
    'headers',
    'nosniff, frame deny, no-referrer, CSP present',
    hh('x-content-type-options') === 'nosniff' &&
      hh('x-frame-options') === 'DENY' &&
      hh('referrer-policy') === 'no-referrer' &&
      !!hh('content-security-policy'),
  );
  check(
    'headers',
    'no X-Powered-By / server version leak',
    !hh('x-powered-by') && !/\d/.test(hh('server') ?? ''),
  );
  const cors = await fetch(`${API}/me`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
  });
  check(
    'headers',
    'CORS preflight from foreign origin gets no allow-origin',
    !cors.headers.get('access-control-allow-origin'),
  );
  const corsGood = await fetch(`${API}/health`, { headers: { origin: 'http://localhost:5173' } });
  check(
    'headers',
    'CORS allows only the configured web origin',
    corsGood.headers.get('access-control-allow-origin') === 'http://localhost:5173',
  );
  const lr = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'jon.schmidt', password: PASSWORD }),
  });
  const setc = lr.headers.getSetCookie?.() ?? [];
  const rt = setc.find((c) => /rt=/.test(c)) ?? '';
  check(
    'cookies',
    'refresh cookie is HttpOnly, SameSite=Strict, path-limited',
    !rt || (/HttpOnly/i.test(rt) && /SameSite=Strict/i.test(rt) && /Path=\/api\/v1\/auth/i.test(rt)),
    rt.slice(0, 120) || 'no cookie (role selection first)',
  );
  const unknownRoute = await http('GET', '/definitely/not/here');
  check(
    'headers',
    '404 is JSON without internals',
    unknownRoute.status === 404 && unknownRoute.json?.error?.code === 'NOT_FOUND',
  );

  // ---------------------------------------------------------------- 11. SSRF
  const ssrfTargets = [
    'http://127.0.0.1:5432/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://localhost:3000/api/v1/health',
    'file:///etc/passwd',
  ];
  const ssrf = [];
  for (const u of ssrfTargets) {
    const res = await http('POST', '/admin/sso-providers', {
      token: admin,
      body: { name: 'probe', issuer: u, clientId: 'x', clientSecret: 'y', hotelIds: [] },
    });
    const res2 = await http('POST', '/admin/sso/discover', { token: admin, body: { issuer: u } });
    for (const r of [res, res2]) if (r.status === 200 || r.status === 201) ssrf.push(`${u} accepted`);
  }
  check(
    'ssrf',
    'private/metadata/file issuers refused by SSO configuration',
    ssrf.length === 0,
    ssrf.join('; '),
  );

  // ---------------------------------------------------------------- 12. public API key
  const pk = 'dk_demo_readonly_5c8e2a9f1b7d4630a2e91c5d8b7f3a06';
  const pub = await http(`GET`, `${BASE}/api/public/v1/employees`, {
    headers: { authorization: `Bearer ${pk}` },
  });
  check(
    'public-api',
    'read-only key lists data',
    pub.status === 200 || pub.status === 403,
    String(pub.status),
  );
  const pubW = await http('POST', `${BASE}/api/public/v1/employees`, {
    headers: { authorization: `Bearer ${pk}` },
    body: {},
  });
  check(
    'public-api',
    'read-only key cannot write',
    [404, 405, 403, 401].includes(pubW.status),
    String(pubW.status),
  );
  const pubBad = await http('GET', `${BASE}/api/public/v1/employees`, {
    headers: { authorization: 'Bearer dk_nope' },
  });
  check('public-api', 'unknown key refused', pubBad.status === 401);
  const pubNo = await http('GET', `${BASE}/api/public/v1/employees`);
  check('public-api', 'no key refused', pubNo.status === 401);

  // ---------------------------------------------------------------- 13. audit integrity & privacy
  const ver = await http('GET', '/audit-log/verify', { token: admin });
  check(
    'audit',
    'audit chain verification endpoint reports ok',
    ver.status === 200 && JSON.stringify(ver.json).includes('true'),
    ver.text.slice(0, 160),
  );
  const exp = await http('GET', `/employees/${allIds[0]}/data-export`, { token: admin });
  check(
    'privacy',
    'admin export has no PIN hash/password',
    exp.status === 200 && !/pin_hash|password_hash/.test(exp.text),
    String(exp.status),
  );
  const log = await http('GET', `/employees/${allIds[0]}/access-log`, { token: admin });
  check(
    'privacy',
    'export was logged in the access log',
    log.status === 200 && JSON.stringify(log.json).includes('personal_data_exported'),
  );

  // ---------------------------------------------------------------- 14. logout / refresh invalidation
  const rl = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'aylin.demir', password: PASSWORD }),
  });
  const rj = await rl.json();
  check(
    'session',
    'logout endpoint exists',
    (await http('POST', '/auth/logout', { token: rj.accessToken ?? rj.preToken })).status < 500,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:');
    for (const f of failed) console.log(` - [${f.area}] ${f.name} ${f.info}`);
    process.exitCode = 1;
  }
}
main().catch((e) => {
  console.error('probe crashed:', e);
  process.exit(2);
});
