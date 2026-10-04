# Single-shot prompt for Claude Code

1. Create an empty git repository and copy this whole pack into it (`CLAUDE.md`, `SPEC.md`, `design/`, `db/`, `tests/`, `docs/`).
2. Start `claude` in that folder (run it in a container or throwaway VM if you allow commands without prompting).
3. Paste everything inside the block below as your first and only message.

```
You are building the v1 of a hotel workforce attendance and scheduling app, fully autonomously, in this repository. Everything you need is in the repo. Do not ask me questions; make the simplest choice that fits the specs and log it in docs/DECISIONS.md.

READ FIRST, in this order: CLAUDE.md, SPEC.md (all of it), design/DESIGN.md, db/schema_v1.sql, tests/vectors.json and tests/reference-rules.mjs. Then open design/prototype.html (use Playwright screenshots of it) and grep design/prototype-source/template.html for exact layouts and copy. Order of authority: SPEC.md > design/DESIGN.md > db/schema_v1.sql > tests/. docs/full-spec.md is reference for backlog features only; never build from it.

TASK: implement milestones M0 to M9 of SPEC.md section 9, in order, with the fixed stack and conventions of CLAUDE.md. Follow the API contract of SPEC.md section 5 exactly (paths, fields, error codes) and keep database names exactly as in db/schema_v1.sql (a change needs a new migration plus a DECISIONS.md line). Build the UI to match the prototype in design/ using design/tokens.css, the Archivo font, radius 0, and German as the default language with English switch, with strings seeded from design/i18n-de-en.json. Where the prototype and SPEC differ, follow design/DESIGN.md section 4. Do not build anything marked v2 or backlog (SPEC.md section 10): no vacation planner view, wishes, messages, blackout periods, month view, wage fields, employee sick reporting, biometrics or GPS.

LOOP for each milestone Mn:
1. Implement it completely, including the tests that SPEC.md section 8 names for it.
2. Run pnpm lint, pnpm typecheck and pnpm test. Fix until green. Never weaken a rule, delete a test or change a test vector to get green. If a vector or spec statement seems wrong, record the conflict in docs/DECISIONS.md, implement the spec as written, and continue.
3. For UI milestones (M0, M5, M6, M7, M8): run the app, compare each screen with the prototype side by side (screenshots), and fix visible differences in layout, spacing, copy and states.
4. Commit with the message "Mn: <title>".
5. Append to docs/PROGRESS.md: milestone, status, test results, open decisions. Then start the next milestone immediately without waiting for me.

CONTEXT: keep working until M9 is done. If your context gets long, summarise into docs/PROGRESS.md and continue from the first unfinished milestone using git log and that file. If Docker is not available, install PostgreSQL 16 locally or use the embedded-postgres npm package for dev and tests, and say so in docs/DECISIONS.md.

QUALITY BARS (never skip): every state-changing endpoint is transactional, validated with zod, authorised through the single scope layer, and writes an audit_log row; PINs, passwords and tokens never appear in logs or emails; times are stored in UTC and durations come from timestamps; rule checks live only in packages/rules; the browser never decides legality; accessibility (keyboard path in the planning grid, visible focus, never colour alone).

FINISH with: pnpm db:migrate, pnpm db:seed, pnpm test, pnpm e2e all green, then print a final report: what works per milestone, the demo logins, usernames, PINs and kiosk token from the seed, how to start the app, the contents of docs/DECISIONS.md, and an explicit list of anything in SPEC.md you did not finish. Begin with M0 now.
```

## Resume prompt (only if a session ends before M9)
```
Read CLAUDE.md, SPEC.md, design/DESIGN.md, docs/PROGRESS.md and docs/DECISIONS.md. Check git log and run pnpm test. Continue with the first unfinished milestone using the same loop and quality bars as before, until M9 is done and the final report is printed.
```

## Notes
- Expect hours of work and possibly more than one session; the resume prompt exists for that.
- Even with this prompt, check the app yourself after M5 (planning) and M6 (kiosk) before relying on it: those two screens decide whether managers will accept the tool.
