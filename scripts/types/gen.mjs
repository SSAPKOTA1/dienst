// Generates packages/shared/src/responses.ts from live responses of the demo-seeded API.
// Usage: BASE=http://localhost:3000 node scripts/types/gen.mjs   (API running on the demo seed)
// Hand-written refinements live in dto.ts; this file only covers shapes that have no mapper.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { authenticator } = require('otplib');
const API = `${process.env.BASE ?? 'http://localhost:3000'}/api/v1`;
const PASSWORD = 'Demo!2345';
const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const j = async (method, path, token, body) => {
  const r = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  try {
    return { status: r.status, json: JSON.parse(t) };
  } catch {
    return { status: r.status, json: null };
  }
};
const login = async (name, role, totp) => {
  const r = await j('POST', '/auth/login', null, {
    login: name,
    password: PASSWORD,
    totp: totp ? authenticator.generate(TOTP) : undefined,
  });
  if (r.json.accessToken) return r.json.accessToken;
  const e = r.json.availableRoles.find((x) => x.role === role);
  return (await j('POST', '/auth/select-role', r.json.preToken, { role, employeeId: e?.employeeId })).json
    .accessToken;
};

const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const monday = new Date(today);
monday.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
const plus = (d, n) => {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
};
const month = iso(today).slice(0, 7);
const year = today.getUTCFullYear();

// [interface name, role, path]
const SAMPLES = [
  ['FeedResponse', 'manager', '/feed?hotelId=1'],
  ['TimeAccountDto', 'employee', '/me/time-account'],
  ['LedgerDto', 'employee', '/me/time-account/ledger'],
  ['ApprovalCountDto', 'manager', '/approvals/count'],
  ['QualificationHeldList', 'admin', '/employees/1/qualifications'],
  ['DocumentList', 'admin', '/employees/1/documents'],
  ['VacationOverviewDto', 'manager', `/vacation/overview?year=${year}`],
  ['VacationNoticeList', 'manager', `/vacation/notices?year=${year}`],
  ['UserList', 'admin', '/users?pageSize=100'],
  ['AdminList', 'superAdmin', '/admins'],
  ['SetupStatusDto', 'admin', '/setup/status'],
  ['SetupOverviewDto', 'admin', '/setup/overview'],
  [
    'AnalyticsSummaryDto',
    'manager',
    `/analytics/summary?from=${iso(plus(monday, -28))}&to=${iso(plus(monday, 6))}`,
  ],
  ['MyAnnouncementList', 'employee', '/me/announcements'],
  ['MySwapList', 'employee', '/me/swap-requests'],
  ['MyQuestionList', 'employee', '/me/questions'],
  ['MyHotelList', 'employee', '/me/hotels'],
  ['AuditLogPage', 'admin', '/audit-log?page=1&pageSize=25'],
  ['AuditVerifyDto', 'admin', '/audit-log/verify'],
  ['ScheduleGridDto', 'manager', `/schedule/grid?hotelIds=1&from=${iso(monday)}&to=${iso(plus(monday, 6))}`],
  ['AnnouncementList', 'manager', '/announcements'],
  ['LiveDto', 'manager', '/live'],
  ['ApprovalList', 'manager', '/approvals?type=worked_time'],
  ['ApprovalAbsenceList', 'manager', '/approvals?type=absence'],
  ['ApprovalCorrectionList', 'manager', '/approvals?type=correction'],
  ['RulesSettingsDto', 'admin', '/settings/rules'],
  ['FeatureSettingList', 'admin', '/settings/features'],
  [
    'ReplacementRestList',
    'manager',
    `/compliance/replacement-rest?from=${iso(plus(monday, -28))}&to=${iso(plus(monday, 6))}`,
  ],
  ['SundayNightList', 'manager', `/compliance/sundays-nights?year=${year}`],
  ['MyAvailabilityList', 'employee', '/me/availability'],
  ['MyDocumentList', 'employee', '/me/documents'],
  ['PunchStatusDto', 'employee', '/me/punch'],
  ['ApiKeyList', 'admin', '/api-keys'],
  ['MyVacationDto', 'employee', '/me/vacation'],
  ['MyQualificationList', 'employee', '/me/qualifications'],
  [
    'TimeOffPreviewDto',
    'employee',
    `/me/time-off-requests/preview?from=${iso(plus(monday, 21))}&to=${iso(plus(monday, 22))}`,
  ],
  ['MyHomeDto', 'employee', '/me/home'],
  ['MyScheduleDto', 'employee', `/me/schedule?from=${iso(monday)}&to=${iso(plus(monday, 6))}`],
  ['ColleagueList', 'employee', '/me/colleagues'],
  ['AttendanceList', 'employee', `/me/attendance?from=${month}-01&to=${month}-28`],
  ['MyShiftList', 'employee', '/me/shifts'],
  ['MyVacationNoticeList', 'employee', '/me/vacation-notices'],
  ['SwapApprovalList', 'manager', '/approvals/swaps?status=accepted_by_peer'],
  ['QuestionList', 'manager', '/questions?status=open'],
  ['HotelSettingsFull', 'admin', '/hotels/1/settings'],
];

// the server refuses a TOTP code twice in one 30 s window: WAIT=1 lets a re-run start in a fresh window
if (process.env.WAIT) await new Promise((r) => setTimeout(r, 31000));
const tokens = {};
tokens.admin = await login('admin@demo.test', 'admin', true);
tokens.manager = await login('manager@demo.test', 'manager', false);
tokens.employee = await login('maria.garcia', 'employee', false);
tokens.superAdmin = await login('sa@demo.test', 'superAdmin', true);

// ---- inference
const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
/** A field that is null in every sample: guess the type from its name (the real type is checked by the web build). */
function guessFromName(name) {
  if (/Slot$/.test(name)) return 'SlotDto | null';
  if (/(^is|^has|^can|^allow|Enabled$|Required$)/.test(name)) return 'boolean | null';
  if (/(Ids)$/.test(name)) return 'number[] | null';
  if (/(Id$|Minutes$|Hours$|Days$|Count$|Pct$|Rate$|^count$|^days$|^hours$)/.test(name))
    return 'number | null';
  return 'string | null';
}
function infer(values, name = '') {
  // values: array of samples of the same position
  const kinds = new Set(values.map(kindOf));
  const parts = [];
  if (kinds.has('null')) parts.push('null');
  for (const k of ['string', 'number', 'boolean']) if (kinds.has(k)) parts.push(k);
  if (kinds.has('array')) {
    const elems = values.filter(Array.isArray).flat();
    parts.push(
      elems.length
        ? `Array<${infer(elems, name)}>`
        : /Ids$/.test(name)
          ? 'number[]'
          : ARRAY_HINTS[name]
            ? `${ARRAY_HINTS[name]}[]`
            : 'unknown[]',
    );
  }
  if (kinds.has('object')) {
    const objs = values.filter((v) => kindOf(v) === 'object');
    const keys = [...new Set(objs.flatMap((o) => Object.keys(o)))];
    const body = keys.map((k) => {
      const present = objs.filter((o) => k in o);
      const optional = present.length < objs.length;
      const key = /^[A-Za-z_]\w*$/.test(k) ? k : JSON.stringify(k);
      return `${key}${optional ? '?' : ''}: ${infer(
        present.map((o) => o[k]),
        k,
      )}`;
    });
    parts.push(`{ ${body.join('; ')} }`);
  }
  if (!parts.length) return 'unknown';
  // `null` alone carries no information about the real type
  return parts.length === 1 && parts[0] === 'null' ? guessFromName(name) : parts.join(' | ');
}

import { readFileSync } from 'node:fs';
const DTO_NAMES = [
  ...readFileSync(new URL('../../packages/shared/src/dto.ts', import.meta.url), 'utf8').matchAll(
    /^export (?:interface|type) (\w+)/gm,
  ),
].map((m) => m[1]);
const HAND = `
export type MyOpenShiftList = Items<MyOpenShiftDto>;
export type TeamAbsenceDto = { enabled: boolean; items: TeamAbsenceItemDto[] };
export type WishList = Items<WishListItemDto>;
export type StaffingSuggestionList = Items<StaffingSuggestionDto>;
export type RestCompensationList = Items<RestCompensationRowDto>;

`;
// element types for arrays that are empty in the demo data, by field name
const ARRAY_HINTS = {
  allowedCidrs: 'string',
  webPunchAllowedCidrs: 'string',
  flags: 'string',
  conflicts: 'ViolationDto',
  issues: 'ViolationDto',
  expectedNotIn: 'LiveLateDto',
  needsReview: 'LiveNeedsReviewDto',
  comments: 'FeedCommentDto',
  notifications: 'NotificationDto',
  hotels: 'PunchHotelDto',
  absences: 'GridAbsenceDto',
};
let out =
  `/* eslint-disable */\n// GENERATED by scripts/types/gen.mjs from live API responses of the demo seed. Do not edit by hand;\n// refine shapes with a mapper type in dto.ts, or extend the generator's sample list.\n\nimport type { ${DTO_NAMES.join(', ')} } from './dto';

` + HAND;
const failed = [];
for (const [name, role, path] of SAMPLES) {
  const r = await j('GET', path, tokens[role]);
  if (r.status !== 200 || r.json === null) {
    failed.push(`${name} ${path} -> ${r.status}`);
    out += `export type ${name} = unknown; // ${path} answered ${r.status}\n\n`;
    continue;
  }
  out += `/** GET ${path.split('?')[0]} */\nexport type ${name} = ${infer([r.json])};\n\n`;
}
const EXTRA = { AttendanceList: 'decisionNote?: string | null;' };
for (const [type, field] of Object.entries(EXTRA)) {
  out = out.replace(new RegExp(`(export type ${type} = \\{\\s*items: Array<\\{)`), `$1 ${field}`);
}
writeFileSync(new URL('../../packages/shared/src/responses.ts', import.meta.url), out);
console.log(`wrote ${SAMPLES.length - failed.length}/${SAMPLES.length} shapes`);
if (failed.length) console.log('not sampled:\n' + failed.join('\n'));
