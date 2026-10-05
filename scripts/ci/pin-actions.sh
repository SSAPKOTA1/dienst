#!/usr/bin/env bash
# Replaces every `uses: owner/repo@tag` in .github/workflows with the commit SHA of that tag and keeps the tag as a comment.
# Needs network access to GitHub and `gh` (logged in). Run once, review the diff, commit; Dependabot then keeps the SHAs fresh.
#   scripts/ci/pin-actions.sh [--check]     --check fails if an action is not pinned (used by CI after the first run)
set -euo pipefail
cd "$(dirname "$0")/../.."
check=0; [[ "${1:-}" == "--check" ]] && check=1
rc=0
while IFS= read -r f; do
  while IFS= read -r ref; do
    action="${ref%@*}"; tag="${ref#*@}"
    [[ "$tag" =~ ^[0-9a-f]{40}$ ]] && continue
    if (( check )); then echo "not pinned: $f $ref"; rc=1; continue; fi
    repo="$(cut -d/ -f1,2 <<<"$action")"
    sha="$(gh api "repos/$repo/commits/$tag" --jq .sha)"
    sed -i "s#uses: $ref\$#uses: $action@$sha # $tag#" "$f"
    echo "$f: $ref -> $sha"
  done < <(grep -oP 'uses: \K[^ ]+@[^ ]+(?=\s*$)' "$f" | sort -u)
done < <(find .github/workflows -name '*.yml')
exit $rc
