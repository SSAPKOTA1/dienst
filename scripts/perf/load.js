/* global __ENV */
// k6 load test: k6 run -e BASE=http://localhost:3000 -e LOGIN=... -e PASSWORD=... [-e TOTP=...] scripts/perf/load.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: 40,
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 50,
    },
  },
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<300'] },
};

const BASE = __ENV.BASE || 'http://localhost:3000';

export function setup() {
  const res = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({ login: __ENV.LOGIN, password: __ENV.PASSWORD, totp: __ENV.TOTP }),
    { headers: { 'content-type': 'application/json' } },
  );
  const body = res.json();
  if (!body.accessToken)
    throw new Error('login did not return an access token (pick an account with one role)');
  return { token: body.accessToken };
}

export default function (data) {
  const headers = { authorization: `Bearer ${data.token}` };
  const me = http.get(`${BASE}/api/v1/me`, { headers });
  check(me, { 'me 200': (r) => r.status === 200 });
  sleep(0.1);
}
