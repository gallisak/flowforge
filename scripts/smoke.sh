#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
setting() {
  grep "^$1=" "$ROOT/.env" | cut -d= -f2- || true
}
API_PORT="${API_PORT:-$(setting API_PORT)}"
WEB_PORT="${WEB_PORT:-$(setting WEB_PORT)}"
API="http://127.0.0.1:${API_PORT:-3000}"
WEB="http://127.0.0.1:${WEB_PORT:-3001}"
ADMIN_TOKEN="$(setting ADMIN_TOKEN)"

fail() {
  echo "smoke test failed: $*" >&2
  exit 1
}

TENANT="$(curl -fsS -X POST "$API/tenants" -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"name":"smoke"}')" \
  || fail "could not create a tenant"
KEY="$(jq -r .apiKey <<<"$TENANT")"

WORKFLOW="$(curl -fsS -X POST "$API/workflows" -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"name":"smoke","steps":[{"id":"note","type":"log","message":"smoke {{ input.run }}"},{"id":"shape","type":"transform","expr":"({ ok: true })"}]}')" \
  || fail "could not create a workflow"
WORKFLOW_ID="$(jq -r .id <<<"$WORKFLOW")"

EXECUTION_ID="$(curl -fsS -X POST "$API/workflows/$WORKFLOW_ID/run" -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{"run":1}' | jq -r .id)" \
  || fail "could not start an execution"

STATUS=""
for _ in $(seq 1 60); do
  STATUS="$(curl -fsS "$API/executions/$EXECUTION_ID" -H "x-api-key: $KEY" | jq -r .status)"
  [[ "$STATUS" == "succeeded" || "$STATUS" == "failed" ]] && break
  sleep 1
done
[[ "$STATUS" == "succeeded" ]] || fail "execution $EXECUTION_ID ended as '$STATUS'"

curl -fsS "$WEB/api/health" >/dev/null || fail "the frontend health check did not answer"
curl -fsS -o /dev/null "$WEB/connect" || fail "the frontend did not serve the connect page"

echo "smoke test passed: execution $EXECUTION_ID succeeded"
