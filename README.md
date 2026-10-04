# Claude Code pack - Hotel Attendance & Scheduling App (v1)

| File | Purpose |
|---|---|
| `CLAUDE.md` | Project rules, fixed stack, commands, definition of done. Claude Code reads it automatically. |
| `SPEC.md` | The precise v1 build spec: roles, rules, API contract, UI, seed data, tests, milestones M0-M9. |
| `PROMPT.md` | The first message to paste into Claude Code, plus a resume prompt. |
| `design/` | The front-end prototype from Claude Design: `prototype.html` (open in a browser), `DESIGN.md` (how to use it, screen inventory, differences to SPEC), `tokens.css`, `fonts/`, `i18n-de-en.json`, `sample-data.json`, `prototype-source/template.html`. |
| `db/schema_v1.sql` | PostgreSQL schema used by v1 (31 tables, validated on PostgreSQL 16). |
| `db/schema_later.sql` | Tables for backlog features, not applied in v1 (validated on top of v1). |
| `tests/vectors.json` | Expected results for the rule functions (breaks, grace period, rest period, daily limit, vacation proration, daylight saving, sick backdating). |
| `tests/reference-rules.mjs` | Reference implementation that generated the vectors. |
| `docs/full-spec.md` | The long specification (v3.3). Reference for backlog features only. |

Order of authority: `SPEC.md` (behaviour) > `design/DESIGN.md` (UI and its overrides) > `db/schema_v1.sql` > `tests/` > `docs/full-spec.md` (reference only).

How to use: create an empty git repository, copy these files into it, start `claude` in the folder, and paste the prompt from `PROMPT.md`.
