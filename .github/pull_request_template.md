## Summary

<!-- What changes and why. Link the issue or decision if there is one. -->

## Checks

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` pass
- [ ] `pnpm e2e` passes when the UI or a flow changed (it includes the accessibility scan)
- [ ] A migration has a `.down.sql` (or says why it cannot be undone) and a test if it changes data
- [ ] New or changed endpoints are in the permission matrix test and write an audit entry
- [ ] No secrets, personal data or real names in code, logs, tests or screenshots
- [ ] `docs/DECISIONS.md` updated when a choice was made

## Risk and rollback

<!-- What could go wrong, how to notice, how to undo (`docs/RUNBOOK.md`). -->
