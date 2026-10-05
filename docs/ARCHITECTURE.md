# Architecture notes

## Layout
- `packages/rules`: pure legal and planning rules (no IO). Coverage floor 90 % statements / 88 % branches (`vitest.config.ts`).
- `packages/shared`: zod schemas and constants shared by API and web.
- `apps/api/src/routes`: one file per area, each a Fastify plugin; `services` hold logic that routes share (`collab.ts`, `planning/*`); `lib` holds cross-cutting code (auth, scope, audit, keys, ssrf).
- `apps/web/src/pages`: one folder per large screen group (`portal/`, `kiosk/`, `admin/`); the file next to it (`Portal.tsx`, `Kiosk.tsx`, `Admin.tsx`) only re-exports, so router and lazy imports did not change.

## Rules of the road
- Routes validate with zod and call the rules package; the browser never decides legality.
- Row mappers (`xOut`) take `Selectable<DB['table']>` (or a `Pick` of the selected columns), not `any`.
- A route file above about 700 lines is split by area into a second plugin registered in `app.ts` (done for swaps/open shifts, comms/feed, organisation/departments and devices).

## Quality gates
- `pnpm lint` fails on any lint error and on more than 293 warnings. The warnings are `no-explicit-any` in production code (mostly web pages reading untyped API JSON). The cap only goes down: when you remove `any`, lower the number in `package.json`. Tests are exempt.
- `pnpm test:coverage` enforces the coverage floors in CI.
- `GET /api/v1/openapi.json` (admins) describes all routes that declare zod schemas; the public API keeps its own handwritten `/api/public/v1/openapi.json`.

## Known debt
- About 260 `any` in web pages come from `useGet` returning untyped JSON; typed DTOs per endpoint (from `packages/shared`) are the next step.
- `Grid.tsx`, `Planning.tsx`, `Vacation.tsx` and several route files are still 700 to 1000 lines.
