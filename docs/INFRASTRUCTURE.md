# Infrastructure

Everything needed to run Dienst, as code. Two supported paths: **Kubernetes** (`deploy/k8s`) and a **single VM** with Docker Compose (`deploy/vm`). Both use the same three images, built and signed by the release workflow.

| Image               | Dockerfile target | Purpose                                              |
| ------------------- | ----------------- | ---------------------------------------------------- |
| `dienst-api`        | `api`             | API, worker (`worker.mjs`) and migrations (`migrate.mjs`) |
| `dienst-web`        | `web`             | nginx-unprivileged (8080), security headers          |
| `dienst-ops`        | `ops`             | `pg_dump`/`pg_restore` 16, age, backup and drill scripts, node |

## Release and deployment pipeline

1. `git tag vX.Y.Z && git push --tags` runs `.github/workflows/release.yml`: build each image, **Trivy gate** (critical/high with a fix block the release), push to GHCR with SBOM and max provenance, **keyless cosign signature**, build attestation, GitHub Release with generated notes.
2. `.github/workflows/deploy.yml` (manual, choose `staging` or `production`, enter the version): the GitHub environment's reviewers approve; the workflow **verifies the cosign signature** of all three images, sets the tags with `kustomize edit set image`, validates with kubeconform, runs the **migration Job first** (a failing migration stops before any pod changes), rolls out api, worker and web, smoke-tests `/api/v1/health/ready` through the public URL and **rolls back** (`kubectl rollout undo`) when anything fails. A migration is not undone by a rollback; migrations are written to be backward compatible for one release (see RUNBOOK).
3. `ci.yml` job `infra` validates all of it on every pull request: both overlays with `kustomize build | kubeconform -strict`, `promtool check rules` and `promtool test rules`, compose files, `shellcheck`, `actionlint`.

One-time setup per GitHub environment: secret `KUBE_CONFIG` (base64 kubeconfig of a service account limited to the `dienst` namespace), variable `BASE_URL`, required reviewers for `production`. Run `scripts/ci/pin-actions.sh` once (needs `gh`) to pin every third-party action to its commit SHA.

## Kubernetes (`deploy/k8s`)

`base` + `overlays/{staging,production}`. Contents: namespace with the *restricted* Pod Security level, api Deployment (2 replicas, rolling update with zero unavailable, startup/liveness/readiness probes, non-root, read-only filesystem, all capabilities dropped, topology spread, preStop drain), HPA (2–6 on CPU), PodDisruptionBudgets, worker Deployment (1 replica, `Recreate`; the jobs are additionally guarded by an advisory lock), web Deployment, Ingress with TLS (cert-manager annotation), NetworkPolicies (default deny ingress; web only from the ingress controller; api only from web and the monitoring namespace; backend egress without the private ranges except DNS), the migration Job, the nightly backup and weekly restore-drill CronJobs with a PVC.

Before the first deploy: create the secrets (`base/secret.example.yaml`, and a `dienst-backup` secret as described in `base/backup.yaml`), change hostnames in the overlays, add an egress rule for your database and mail relay in the overlay (they usually sit in a private range), set the images' registry owner if your GitHub owner differs from `ssapkota1`.

## Single VM (`deploy/vm`)

`bootstrap.sh` installs Docker, a firewall (22, 80, 443), an unprivileged `dienst` user and the systemd timers for the nightly backup and the weekly restore drill (the drill runs in the `ops` image). `docker-compose.vm.yml` adds Caddy (automatic TLS) in front of the web container. Start: `docker compose -f docker-compose.prod.yml -f deploy/vm/docker-compose.vm.yml --env-file .env.production up -d`.

## Monitoring (`deploy/monitoring`, `deploy/grafana`, `deploy/alerts.yml`)

`docker-compose.monitoring.yml` runs Prometheus, Alertmanager, node_exporter (for the backup textfile) and Grafana (bound to localhost; use an SSH tunnel or VPN). The dashboard `deploy/grafana/dienst-dashboard.json` is provisioned automatically and shows traffic, errors, latency percentiles, slow routes, punches by source, failed logins, database pool, job health and backup age.

Alerts (`deploy/alerts.yml`, unit-tested in `deploy/tests/alerts.test.yml`): API down, 5xx ratio, slow requests, failed logins, failing/stale jobs, pool exhausted, offline tablet, backup too old or missing, server-error bursts. **Set the receiver in `alertmanager.yml`** – the default is a placeholder, so nothing is delivered until you do.

## What is verified, and what is not

Verified in CI and locally: manifests against the Kubernetes schemas, alert rules by unit tests, shell scripts, workflows, compose rendering, backup/restore/drill end to end, container smoke tests. **Not verifiable without your accounts:** a real cluster or VM, DNS and certificates, GHCR permissions, cosign verification of a real release, delivery of alerts to a real person. Run one staging deployment and one deliberate failure (stop the database, kill the worker) before you rely on it.
