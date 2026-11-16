#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
setting_in() {
  grep "^$2=" "$1" 2>/dev/null | tail -n 1 | cut -d= -f2- | sed -E "s/[[:space:]]+#.*$//; s/^[[:space:]]*(\"(.*)\"|'(.*)')[[:space:]]*$/\\2\\3/" || true
}
setting() {
  setting_in "$ROOT/.env" "$1"
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
  STATUS="$(curl -fsS "$API/executions/$EXECUTION_ID" -H "x-api-key: $KEY" | jq -r .status || true)"
  [[ "$STATUS" == "succeeded" || "$STATUS" == "failed" ]] && break
  sleep 1
done
[[ "$STATUS" == "succeeded" ]] || fail "execution $EXECUTION_ID ended as '$STATUS'"

curl -fsS "$WEB/api/health" >/dev/null || fail "the frontend health check did not answer"
curl -fsS -o /dev/null "$WEB/connect" || fail "the frontend did not serve the connect page"

FAILURES_PER_MINUTE="$(setting_in "$ROOT/apps/api/.env" AUTH_FAILURES_PER_MINUTE)"
APP_ORIGIN="$(setting APP_ORIGIN)"
LIMITED=""
for attempt in $(seq 1 $(( 3 * ${FAILURES_PER_MINUTE:-60} ))); do
  CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$WEB/api/connect" -H "origin: ${APP_ORIGIN:-$WEB}" -H 'content-type: application/json' \
    -H "x-forwarded-for: 198.51.100.$(( attempt % 250 + 1 ))" -d '{"apiKey":"ff_smoke_wrong_key"}')"
  [[ "$CODE" == "429" ]] && LIMITED=1 && break
done
[[ -n "$LIMITED" ]] || fail "failed logins with a forged X-Forwarded-For were never limited"

EDGE="$(docker ps -q --filter label=com.docker.compose.service=edge --filter "publish=${WEB_PORT:-3001}" | head -n 1)"
[[ -n "$EDGE" ]] || fail "could not find the edge container published on port ${WEB_PORT:-3001}"
OTHER_CLIENT="$(docker exec "$EDGE" sh -c "wget -S -O /dev/null --header 'content-type: application/json' \
  --header 'origin: ${APP_ORIGIN:-http://127.0.0.1:8080}' --post-data '{\"apiKey\":\"ff_smoke_other_client\"}' \
  http://127.0.0.1:8080/api/connect 2>&1 | grep -m 1 -o 'HTTP/1.1 [0-9]*' || true")"
[[ "$OTHER_CLIENT" == "HTTP/1.1 400" ]] \
  || fail "another client was answered '$OTHER_CLIENT' instead of 400: the frontend and the API do not share CLIENT_ADDRESS_SECRET"

echo "smoke test passed: execution $EXECUTION_ID succeeded, forged client addresses are limited, other clients are not"
