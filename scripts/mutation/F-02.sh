#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
TARGET="src/executions/executions.service.ts"
ORIGINAL="where: { tenantId }, order: { createdAt: 'DESC' }"
MUTANT="where: {}, order: { createdAt: 'DESC' }"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ff-mutation-F-02.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

rsync -a --exclude node_modules --exclude dist "$ROOT/apps/api/" "$TMP/api/"
ln -s "$ROOT/apps/api/node_modules" "$TMP/api/node_modules"

python3 - "$TMP/api/$TARGET" "$ORIGINAL" "$MUTANT" <<'PY'
import sys
path, original, mutant = sys.argv[1:4]
source = open(path, encoding="utf-8").read()
if source.count(original) != 1:
    sys.exit(f"mutation target not found exactly once in {path}: {original!r}")
open(path, "w", encoding="utf-8").write(source.replace(original, mutant))
PY

echo "Mutant F-02: ExecutionsService.list() returns executions of every tenant"
echo "Running the whole API test suite against the mutant..."

if (cd "$TMP/api" && npx jest --ci >"$TMP/jest.log" 2>&1); then
  echo "✘ SURVIVED: every test passes although executions of other tenants are listed"
  grep -E '^(Tests|Test Suites):' "$TMP/jest.log" || true
  exit 1
fi

if grep -qE '^Tests:.*[0-9]+ failed' "$TMP/jest.log"; then
  echo "✔ KILLED: the test suite detects the mutant"
  grep -E '^  ● ' "$TMP/jest.log" | sort -u || true
  exit 0
fi

echo "Test run failed for a reason other than assertions:" >&2
tail -n 60 "$TMP/jest.log" >&2
exit 2
