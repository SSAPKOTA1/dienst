#!/usr/bin/env bash
# Installs the infrastructure validators (kustomize, kubeconform, promtool, actionlint) with pinned versions into $1.
set -euo pipefail
DEST="${1:?target directory}"
KUSTOMIZE=5.5.0 KUBECONFORM=0.6.7 PROM=2.55.1 ACTIONLINT=1.7.4
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
dl() { curl -fsSL --retry 3 "$1" -o "$T/$2"; }
dl "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv$KUSTOMIZE/kustomize_v${KUSTOMIZE}_linux_amd64.tar.gz" k.tgz
dl "https://github.com/yannh/kubeconform/releases/download/v$KUBECONFORM/kubeconform-linux-amd64.tar.gz" kc.tgz
dl "https://github.com/prometheus/prometheus/releases/download/v$PROM/prometheus-$PROM.linux-amd64.tar.gz" p.tgz
dl "https://github.com/rhysd/actionlint/releases/download/v$ACTIONLINT/actionlint_${ACTIONLINT}_linux_amd64.tar.gz" a.tgz
tar -xzf "$T/k.tgz" -C "$T" kustomize
tar -xzf "$T/kc.tgz" -C "$T" kubeconform
tar -xzf "$T/p.tgz" -C "$T" --strip-components=1 "prometheus-$PROM.linux-amd64/promtool"
tar -xzf "$T/a.tgz" -C "$T" actionlint
sudo_cmd=""; [[ -w "$DEST" ]] || sudo_cmd="sudo"
$sudo_cmd install -m 0755 "$T/kustomize" "$T/kubeconform" "$T/promtool" "$T/actionlint" "$DEST/"
