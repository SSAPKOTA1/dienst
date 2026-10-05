#!/usr/bin/env bash
# Prepares a fresh Debian/Ubuntu VM: Docker, firewall, an unprivileged service user, the backup timers.
# Run once as root:  DIENST_DOMAIN=dienst.example.com ./bootstrap.sh
set -euo pipefail
: "${DIENST_DOMAIN:?set DIENST_DOMAIN}"
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl ufw age postgresql-client unattended-upgrades
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

id dienst >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/dienst --shell /usr/sbin/nologin dienst
usermod -aG docker dienst
install -d -o dienst -g dienst -m 0750 /opt/dienst /var/backups/dienst

ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

install -m 0644 "$HERE/systemd/"*.service "$HERE/systemd/"*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now dienst-backup.timer dienst-restore-drill.timer
echo "Next: copy the repository to /opt/dienst, create .env.production (see .env.production.example) and start the stack."
echo "Domain: $DIENST_DOMAIN"
