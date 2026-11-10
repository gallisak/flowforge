#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^F-[0-9]{2,}$ ]]; then
  echo "Usage: $0 F-NN" >&2
  exit 2
fi
ID="$1"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

TEST_COMMIT="$(git log --format=%H --grep="^test(${ID}):" -n 1)"
FIX_COMMIT="$(git log --format=%H --grep="^fix(${ID}):" -n 1)"
[[ -n "$TEST_COMMIT" ]] || { echo "No commit found matching test(${ID}): ..." >&2; exit 2; }
[[ -n "$FIX_COMMIT" ]] || { echo "No commit found matching fix(${ID}): ..." >&2; exit 2; }

if [[ ! -d "$ROOT/apps/api/node_modules" ]]; then
  echo "Install dependencies first: (cd apps/api && npm ci)" >&2
  exit 2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ff-prove-${ID}.XXXXXX")"
cleanup() {
  for dir in "$TMP"/*/; do
    [[ -d "$dir" ]] && git -C "$ROOT" worktree remove --force "$dir" >/dev/null 2>&1 || true
  done
  rm -rf "$TMP"
  git -C "$ROOT" worktree prune
}
trap cleanup EXIT

run_at() {
  local commit="$1" label="$2" dir="$TMP/$2"
  git worktree add --detach --quiet "$dir" "$commit"
  [[ -e "$dir/apps/api/node_modules" ]] || ln -s "$ROOT/apps/api/node_modules" "$dir/apps/api/node_modules"
  local log="$TMP/$label.log"
  if (cd "$dir/apps/api" && npx jest --ci "findings/${ID}-" >"$log" 2>&1); then
    echo green
  elif grep -qE '^Tests:.*[0-9]+ failed' "$log"; then
    echo red
  else
    echo error
  fi
}

short() { git log --format='%h %s' -n 1 "$1"; }

echo "▶ ${ID}"
echo "  reproduction:  $(short "$TEST_COMMIT")"
echo "  fix:           $(short "$FIX_COMMIT")"

BEFORE="$(run_at "$TEST_COMMIT" before)"
AFTER="$(run_at "$FIX_COMMIT" after)"

echo "  before fix: $BEFORE (expected red)"
echo "  after fix:  $AFTER (expected green)"

if [[ "$BEFORE" == red && "$AFTER" == green ]]; then
  echo "✔ ${ID} proven"
  exit 0
fi

echo "✘ ${ID} not proven. Logs:" >&2
for label in before after; do
  echo "----- $label -----" >&2
  tail -n 60 "$TMP/$label.log" >&2 || true
done
exit 1
