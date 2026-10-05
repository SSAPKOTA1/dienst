# Repository settings to turn on (GitHub)

These settings cannot be set from the code; do them once under Settings. They make the checks in `.github/workflows` binding.

## Branch protection for `main` (Settings → Branches → Add rule)
- Require a pull request before merging; require 1 approval; dismiss stale approvals on new commits; require review from code owners (`.github/CODEOWNERS`).
- Require status checks to pass, branches up to date: `lint, types, tests`, `end-to-end (Playwright, accessibility)`, `images, smoke tests, backups, SBOM, scan`, `gitleaks (whole history)`, `CodeQL (JavaScript/TypeScript)`.
- Require conversation resolution; require linear history is optional (the project uses merge commits).
- Block force pushes and deletions; do not allow bypassing for administrators.

## Security features (Settings → Code security)
- Dependency graph, Dependabot alerts and Dependabot security updates: on.
- Secret scanning and push protection: on.
- Code scanning (CodeQL from `codeql.yml`): on; the SBOM is attached to every `ci` run as an artifact.
- Private vulnerability reporting: on (referenced by `SECURITY.md`).

## Actions (Settings → Actions → General)
- Workflow permissions: read repository contents only (the workflows also declare `permissions:`).
- Require approval for workflows from outside collaborators.
- Pin third-party actions to commit SHAs when your organisation requires it: run `npx pinact run` (it rewrites tags to SHAs; Dependabot then keeps them current). The workflows use release tags so that they work without a lookup.
