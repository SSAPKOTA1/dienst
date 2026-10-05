// Load test with autocannon against a running API on the synthetic perf database.
//   createdb dienst_perf && DATABASE_URL=.../dienst_perf pnpm db:migrate && psql dienst_perf -f scripts/perf/seed.sql
//   DATABASE_URL=.../dienst_perf node scripts/perf/prepare.mjs
//   DATABASE_URL=.../dienst_perf RATE_LIMIT_GLOBAL=1000000 RATE_LIMIT_KIOSK=1000000 RATE_LIMIT_AUTH=1000 pnpm --filter @dienst/api start
//   node scripts/perf/load.mjs            (BASE, CONNECTIONS, DURATION, BUDGET=0 to only report)
// Exit code 1 when a scenario is over its budget (p95 latency in ms, error rate). Budgets are for a 4-core laptop class
// machine with API and database on the same host; CI uses `BUDGET_FACTOR` to loosen them.
import autocannon from 'autocannon';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 20);
const DURATION = Number(process.env.DURATION ?? 8);
const FACTOR = Number(process.env.BUDGET_FACTOR ?? 1);
const ENFORCE = process.env.BUDGET !== '0';
const PASSWORD = 'Perf!Test-12345';

const login = async (name) => {
  const r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: name, password: PASSWORD }),
  });
  const j = await r.json();
  if (j.accessToken) return j.accessToken;
  const role = j.availableRoles?.[0];
  const s = await fetch(`${BASE}/api/v1/auth/select-role`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${j.preToken}` },
    body: JSON.stringify({ role: role.role, employeeId: role.employeeId }),
  });
  return (await s.json()).accessToken;
};
const mgr = await login('perf-mgr@x.test');
const emp = await login('e1@perf.test');
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const week = '/api/v1/schedule/grid?hotelIds=1&from=2026-06-01&to=2026-06-07';

// [name, path, headers, p95 budget ms, max error rate, method, connections]
const SCENARIOS = [
  ['health (floor)', '/api/v1/health', {}, 40, 0],
  ['auth path: GET /me', '/api/v1/me', bearer(mgr), 80, 0],
  ['employee: my home', '/api/v1/me/home', bearer(emp), 120, 0],
  ['manager: approvals count', '/api/v1/approvals/count', bearer(mgr), 80, 0],
  ['manager: staff list (50)', '/api/v1/employees?pageSize=50', bearer(mgr), 200, 0, 'GET', 5],
  ['manager: week grid of one hotel (100 people)', week, bearer(mgr), 1500, 0, 'GET', 5],
  ['kiosk: roster (100 people)', '/api/v1/kiosk/roster', { 'x-kiosk-token': 'kd_perf_tablet_token' }, 150, 0],
  ['kiosk: heartbeat', '/api/v1/kiosk/heartbeat', { 'x-kiosk-token': 'kd_perf_tablet_token' }, 40, 0, 'POST'],
];

const run = (opts) =>
  new Promise((resolve, reject) => {
    const inst = autocannon(opts, (err, res) => (err ? reject(err) : resolve(res)));
    autocannon.track(inst, {
      renderProgressBar: false,
      renderResultsTable: false,
      renderLatencyTable: false,
    });
  });

const rows = [];
let failed = false;
const idle = async () => {
  // let the server finish what the previous scenario left in flight
  for (let i = 0; i < 60; i++) {
    const t0 = Date.now();
    await fetch(`${BASE}/api/v1/health`).then((r) => r.text());
    if (Date.now() - t0 < 15) return;
    await new Promise((r) => setTimeout(r, 500));
  }
};
for (const [name, path, headers, p95Budget, errBudget, method = 'GET', conns = CONNECTIONS] of SCENARIOS) {
  await idle();
  const res = await run({
    url: BASE + path,
    method,
    headers: method === 'POST' ? { ...headers, 'content-type': 'application/json' } : headers,
    connections: conns,
    duration: DURATION,
    body: method === 'POST' ? '{}' : undefined,
  });
  const total = res.requests.total + res.non2xx + res.errors;
  const errRate = total ? (res.non2xx + res.errors) / total : 0;
  const budget = p95Budget * FACTOR;
  const ok = res.latency.p97_5 <= budget * 1.0 && errRate <= errBudget;
  rows.push({
    name,
    rps: Math.round(res.requests.average),
    p50: res.latency.p50,
    p97_5: res.latency.p97_5,
    p99: res.latency.p99,
    errors: res.non2xx + res.errors,
    budget,
    ok,
  });
  if (!ok) failed = true;
}
console.log(`\nconnections ${CONNECTIONS}, ${DURATION}s per scenario, budget factor ${FACTOR}\n`);
console.log(
  'scenario'.padEnd(48),
  'req/s'.padStart(7),
  'p50'.padStart(6),
  'p97.5'.padStart(7),
  'p99'.padStart(6),
  'budget'.padStart(7),
  'err'.padStart(5),
  '',
);
for (const r of rows)
  console.log(
    r.name.padEnd(48),
    String(r.rps).padStart(7),
    String(r.p50).padStart(6),
    String(r.p97_5).padStart(7),
    String(r.p99).padStart(6),
    String(r.budget).padStart(7),
    String(r.errors).padStart(5),
    r.ok ? 'ok' : 'OVER BUDGET',
  );
if (failed && ENFORCE) process.exitCode = 1;
