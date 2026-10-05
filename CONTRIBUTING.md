# Contributing

Start with [docs/DEVELOPER.md](docs/DEVELOPER.md) (setup, structure, how to make a change, pitfalls). The short version:

- Behaviour comes from `SPEC.md` and `docs/BACKLOG-SPEC.md`; project rules are in `CLAUDE.md`.
- `pnpm lint && pnpm typecheck && pnpm test` must pass; add tests with every change; update `docs/manual/*` (de and en) and run `pnpm docs:api` for visible or API changes.
- Report security problems privately, see [SECURITY.md](SECURITY.md) if present, otherwise contact the repository owner; do not open a public issue.
