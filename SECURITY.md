# Security policy

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub's "Report a vulnerability" (Security tab) or to the repository owner. Include what you found, how to reproduce it and what you think the impact is. You will get an answer within 3 working days and a fix or a plan within 30 days for confirmed issues.

## What is in scope

The API (`apps/api`), the web app (`apps/web`), the container images and the scripts in `scripts/ops`. Out of scope: findings that need a compromised administrator, denial of service by volume, and missing hardening on a development setup.

## Supported versions

The latest release (`main`) receives security fixes.

## How the project protects itself

Dependencies are audited in CI and updated weekly (Dependabot), code is scanned by CodeQL, the history is scanned for secrets, images are scanned and an SBOM is produced on every build. The design (keys, headers, audit log, API keys, proxies) is described in `docs/DEPLOYMENT.md` and `docs/DECISIONS.md`.
