# FlowForge

Multi-tenant durable workflow platform: a workflow is a list of `http`, `transform`, `log` and `delay`
steps started through the API, a signed webhook or a cron schedule. NestJS (API, workers, schedulers from
one code base), Next.js 15, PostgreSQL 16 as the only queue and state store.

[Running](#running) · [Architecture](#architecture) · [Guarantees](#execution-guarantees) ·
[Decisions](#design-decisions) · [Findings](#findings) · [Indexes](#indexes-and-query-plans) ·
[Tests, chaos, load](#tests-chaos-and-load) · [Changed tests](#changes-to-existing-tests) ·
[Not done](#not-done-or-done-differently)

## Running

```bash
cp .env.example .env                    # fill in ADMIN_TOKEN and the three passwords
cp apps/api/.env.example apps/api/.env
docker compose -p flowforge up -d --build --wait
scripts/smoke.sh                        # tenant, workflow, run until succeeded, frontend
```

UI http://localhost:3001, API http://localhost:3000, API reference [`docs/openapi.json`](docs/openapi.json)
(OpenAPI 3.1). Compose starts Postgres, a one-off `migrate` job, the API, two workers, two schedulers and
the frontend; ports are published on `127.0.0.1` only; `/metrics` and `/health/{live,ready}` are on port
9100 inside the compose network.

| File | Holds |
|---|---|
| `.env` | `ADMIN_TOKEN` (`openssl rand -hex 32`), `POSTGRES_PASSWORD`, `FLOWFORGE_OWNER_PASSWORD`, `FLOWFORGE_APP_PASSWORD` (`openssl rand -hex 24`), ports, optional `APP_ORIGIN` |
| `apps/api/.env` | every platform setting with its default, validated at start-up |
| `apps/frontend/.env` | `API_URL` for `npm run dev` of the frontend |

- Compose builds the database URLs from `.env`: only `migrate` gets the owner role, the services get
  `flowforge_app`, only the API gets the admin token. A service refuses to start as the table owner, a
  superuser or a `BYPASSRLS` role.
- Roles are created when the `flowforge_pgdata` volume is created; a changed password later needs
  `ALTER ROLE` or `down -v`.
- Behind a TLS terminator set `APP_ORIGIN` (`https://...`): the frontend checks `Origin` against it and
  marks the key cookie `Secure`.

### Example requests

```bash
API=http://localhost:3000
ADMIN_TOKEN=$(grep ^ADMIN_TOKEN= .env | cut -d= -f2)
TENANT=$(curl -s -XPOST $API/tenants -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"name":"demo"}')
KEY=$(echo "$TENANT" | jq -r .apiKey); SECRET=$(echo "$TENANT" | jq -r .webhookSecret)

WF=$(curl -s -XPOST $API/workflows -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{
  "name": "order",
  "steps": [
    {"id": "order", "type": "http", "method": "POST", "url": "https://httpbin.org/anything/orders",
     "headers": {"content-type": "application/json"},
     "body": "{\"customer\": \"{{ input.customer }}\", \"amount\": {{ input.amount }}}"},
    {"id": "pause", "type": "delay", "ms": 3000},
    {"id": "summary", "type": "transform", "expr": "({ total: ctx.steps.order.body.json.amount * 1.2 })"}
  ]}' | jq -r .id)

EX=$(curl -s -XPOST $API/workflows/$WF/run -H "x-api-key: $KEY" -H 'x-request-id: demo-1' \
  -H 'content-type: application/json' -d '{"customer": "Ann", "amount": 100}' | jq -r .id)
curl -N $API/executions/$EX/events -H "x-api-key: $KEY"        # pending → running → waiting → succeeded
curl -s "$API/executions?status=succeeded&limit=20" -H "x-api-key: $KEY"   # next page: X-Next-Cursor

BODY='{"customer": "Bob", "amount": 50}'; ID=evt_1; TS=$(date +%s)
SIG=$(node -e 'const c=require("crypto");const [s,id,ts,b]=process.argv.slice(1);
console.log("v1,"+c.createHmac("sha256",Buffer.from(s.slice(6),"base64")).update(`${id}.${ts}.${b}`).digest("base64"))' \
  "$SECRET" "$ID" "$TS" "$BODY")
curl -s -XPOST $API/hooks/$WF -H 'content-type: application/json' \
  -H "webhook-id: $ID" -H "webhook-timestamp: $TS" -H "webhook-signature: $SIG" -d "$BODY"   # again: same executionId
```

Notifications: `PUT /notifications/endpoint {"url": "https://..."}` (the signing secret is returned
once), delivery state at `GET /notifications/events?status=dead`.

## Architecture

Entry points `dist/main` (API), `dist/worker` (job runner, lease reaper, outbox dispatcher, retention),
`dist/scheduler`, `dist/migrate`; processes coordinate only through Postgres. Each `T` box is one
transaction. Every write of a worker is fenced: it checks in the same transaction that the job is still
`running` with its `lockedBy` and `attempts`.

```mermaid
flowchart TD
  trigger["API run / signed webhook / cron occurrence"] --> T1
  T1["T1 enqueue: execution with workflow version and trigger key + job;
  a duplicate trigger key returns the existing execution"] --> queue[("jobs: queued")]
  queue --> T2["T2 claim_job: fair tenant choice, FOR UPDATE SKIP LOCKED,
  running, lease, attempts + 1"]
  T2 --> load["read execution, version snapshot, checkpoints (no writes)"]
  load --> T3["T3 mark running (fenced): execution running unless it is already final"]
  T3 -->|next step is a delay that is due| T4
  T4["T4 wake up (fenced): waiting step_run succeeded"] --> T5
  T3 -->|next step| T5["T5 start step (fenced): step_run running, idempotency key"]
  T5 --> effect[["run the step outside any transaction"]]
  effect -->|success| T6["T6 checkpoint (fenced): step_run succeeded + output"]
  T6 -->|next step| T5
  T6 -->|next step is a delay| T8
  T6 -->|last step| T7["T7 complete (fenced): job done, execution succeeded, error cleared, outbox event"]
  effect -->|error| T9["T9 fail (fenced): step_run failed; job queued with backoff, failed or dead;
  execution pending or failed; outbox event when final"]
  T3 -->|next step is a delay that is not due| T8
  T8["T8 park (fenced): step_run waiting with wakeAt,
  job queued at wakeAt, attempt given back, execution waiting"] --> queue
  T9 -->|retry| queue
  sigterm["SIGTERM after the grace period"] --> T10["T10 release (fenced): job queued, attempt given back,
  interrupted step_run failed, execution pending"] --> queue
  reaper["T11 reap_expired_jobs: expired lease -> queued (execution pending) or dead (failed execution,
  outbox event); the interrupted step_run failed"] --> queue
  T7 --> outbox[("outbox_events")]
  T9 --> outbox
  outbox --> T12["T12 claim_outbox_events: per-tenant turns, SKIP LOCKED, lease"]
  T12 --> post[["POST signed notification"]]
  post --> T13["T13 record result (fenced): delivered, retry later or dead"]
```

## Execution guarantees

| What | Guarantee | Conditions |
|---|---|---|
| Job | Run by at most one worker at a time | Lease + fencing; a worker gives a job up when its last renewal is older than the lease minus 1 s |
| `http` step | At least once; effectively once if the receiver deduplicates by `Idempotency-Key` | Key `<executionId>:<stepId>` and the same body on every attempt; repeated only if the step did not finish |
| `transform`, `log` | At least once | No external effect |
| Succeeded step | Never run again | Output stored with the success in one fenced transaction |
| `delay` | Wakes up no earlier than `wakeAt` | Survives restarts, holds no worker slot |
| Execution | One final state, steps of one version | Version fixed at creation; fails after `JOB_MAX_ATTEMPTS` (8) attempts of one step, a non-retryable error or outputs over `EXECUTION_OUTPUT_MAX_BYTES` |
| Webhook / cron trigger | One execution per `(workflow, webhook-id)` / `(workflow, scheduled time)` | Unique trigger key (+ row lock on the schedule) |
| API run | One execution per request | No client idempotency key |
| Notification | At least once, same `webhook-id` on every attempt | Written in the transaction of the final status; 15 attempts with backoff, then `dead`; order not guaranteed |

## Design decisions

### 3.3.1 Queue
- **Chosen:** `claim_job` (`FOR UPDATE SKIP LOCKED`) sets a lease; chained heartbeats every third of the
  lease plus a local deadline; a reaper in every worker; fencing on every write. Attempts count per step
  (`JOB_MAX_ATTEMPTS`, 8); jittered exponential backoff (`RETRY_BASE_MS`, `RETRY_CAP_MS`), also after a
  lease expired; retryable: network errors, timeouts, 5xx, 408, 425, 429; exhausted jobs are `dead`.
  SIGTERM: stop claiming, wait `WORKER_SHUTDOWN_GRACE_MS`, return unfinished jobs without counting the attempt.
- **Why:** one statement claims, so a job cannot be taken twice; a lease lets a job run for minutes
  without an open transaction; counting per step keeps the progress of long workflows.
- **Alternatives:** advisory locks (no record of the holder, no "retry at"); `LISTEN/NOTIFY` only (not durable).
- **Limits:** a dead worker is noticed after the lease plus a reaper pass (30 + 5 s); idle slots poll every
  250 ms; the worker pool needs `2 × WORKER_CONCURRENCY + OUTBOX_CONCURRENCY + 2` connections (`DB_POOL_SIZE`).

### 3.3.2 Durable execution
- **Chosen:** one `step_runs` row per step; a retry rebuilds `ctx.steps` from succeeded rows and starts at
  the first unfinished step; later steps always read the stored output, so a retried request has the same
  bytes. `Idempotency-Key` and `X-Correlation-Id` on every http request. Changing `steps` inserts an
  immutable `workflow_versions` row; an execution runs the version it was created with.
- **Why:** checkpoint and success are one transaction, so a succeeded step is never computed again.
- **Alternatives:** copying the steps into every execution (duplication, no history).
- **Limits:** effectively-once needs a receiver that honours the key.

### 3.3.3 Durable timers
- **Chosen:** a `delay` marks its step `waiting` with `wakeAt` and requeues the job with `runAt = wakeAt`,
  giving the attempt back, in one transaction.
- **Why:** the timer is a row, survives restarts and needs no extra process.
- **Alternatives:** a timers table with its own poller.
- **Limits:** wake-up is later than `wakeAt` by up to the poll interval, or while the tenant is at its limit.

### 3.3.4 Tenant isolation and limits
- **Chosen:** services connect as `flowforge_app` (`NOBYPASSRLS`) and refuse to start as anything more
  privileged; the schema belongs to `flowforge_owner`. Every tenant table has row level security on
  `app.tenant_id`, set per transaction by `TenantDb.run`; cross-tenant work (key lookup, webhook routing,
  claims, reaper, retention, metrics) goes through narrow `SECURITY DEFINER` functions; services also
  filter by `tenantId`. The application role cannot change `migrations`, `workflow_versions` or `tenants`.
- **Limits per tenant** (`PATCH /tenants/:id/limits`, range checked in the database): concurrent jobs, that is
  running executions (in `claim_job`, exact; a sleeping `delay` does not count), ready jobs in the queue (`429` + `Retry-After`), requests per minute (fixed
  window in Postgres, `X-RateLimit-*`), workflows (`TENANT_MAX_WORKFLOWS`). Failed authentication is
  limited per address in memory before any database work (`AUTH_FAILURES_PER_MINUTE`).
- **Why:** a missing check in code still cannot leak data (`tenancy/row-level-security.int-spec.ts`).
- **Alternatives:** schema per tenant (migrations × tenants); in-memory rate limits (grow with instances).
- **Limits:** the queue limit is soft under concurrent requests and ignores sleeping jobs; the rate window
  allows up to 2× around its edge.

### 3.3.5 Fair scheduling
- **Chosen:** `claim_job` walks tenants with queued jobs (skip scan, one index probe each), keeps those
  whose oldest job is due, takes the least recently served one it can lock with `SKIP LOCKED` and whose
  concurrency limit allows it, and claims its oldest job.
- **Why:** round-robin between tenants: a backlog costs others at most one job per turn ([measured](#load-fair-scheduling)).
- **Alternatives:** a queue and dispatcher per tenant; random tenant choice (weaker tail).
- **Limits:** fair per job, not per CPU time; no weights.

### 3.3.6 Safe step execution
- **`http`:** guarded undici agent; the URL template needs a fixed origin, values are percent-encoded,
  the rendered origin is checked again and `.`/`..` path segments are refused. Its `lookup` resolves every
  address (c-ares, 2 s) and refuses any that is not public unicast, then connects to the checked address,
  so DNS rebinding cannot redirect it. Redirects are followed by hand (`HTTP_MAX_REDIRECTS`), each hop
  checked again, credentials and custom headers dropped across origins. One deadline per step
  (`HTTP_TIMEOUT_MS`), body cut at `HTTP_MAX_RESPONSE_BYTES`. Bodies with a JSON type or JSON shape are
  rendered with JSON escaping.
- **`transform`:** JavaScript in QuickJS (WebAssembly) in a small thread pool; each evaluation gets a fresh
  runtime with `TRANSFORM_MEMORY_MB`, a 48 KiB stack and `TRANSFORM_TIMEOUT_MS`; JSON in and out, so no
  host object is reachable; the expression is compiled apart from the wrapper and the result size is
  checked before it leaves the sandbox; a thread that misses the deadline is replaced.
- **All steps:** an output over `STEP_OUTPUT_MAX_BYTES` or 64 levels, or outputs of one execution over
  `EXECUTION_OUTPUT_MAX_BYTES`, fail without retry; rendered urls (8 KiB) and bodies (1 MiB) are bounded
  while they render; definitions are limited (50 steps, body 64 KiB, expression 4 KiB, delay ≤ 1 h).
- **Why QuickJS:** existing workflows use JavaScript expressions; `vm`/`new Function` are not a boundary;
  `isolated-vm` is a native module per Node version; WebAssembly has no Node APIs and exact limits.
- **Alternatives:** `request-filtering-agent` (no redirect control), an egress proxy, an expression language.
- **Limits:** the SSRF guard lives in the worker; `SSRF_ALLOWLIST` bypasses it per host; built-ins like
  `'x'.repeat(n)` do not check the deadline, so the hard kill comes at twice the timeout.

### 3.3.7 Incoming webhooks
- **Chosen:** Standard Webhooks: `v1,<base64 HMAC-SHA256(id.timestamp.raw body)>` over the bytes as
  received (compressed bodies `415`), `timingSafeEqual` against every active secret, timestamp within
  `WEBHOOK_TOLERANCE_SECONDS`, trigger key `webhook:<workflowId>:<webhook-id>` with a unique index.
  Rotation: `POST /webhook-secrets` returns a new secret once, old ones stay valid for
  `WEBHOOK_SECRET_GRACE_SECONDS`, at most three are active.
- **Why:** senders already implement the scheme; the unique key makes any later redelivery a no-op.
- **Alternatives:** a seen-ids table cleaned after the window (lets late retries through).
- **Limits:** secrets are stored in plain text, protected by row level security.

### 3.3.8 Scheduler
- **Chosen:** a separate process (two replicas); `workflows.nextRunAt` is indexed; a tick claims one due
  workflow at a time (`FOR UPDATE SKIP LOCKED`), enqueues with trigger key `cron:<workflowId>:<time>` and
  moves `nextRunAt` in the same transaction. Missed runs older than `SCHEDULER_MISFIRE_GRACE_MS`: `skip`,
  `once` (default) or `all` (up to `SCHEDULER_MAX_CATCH_UP_RUNS`); skipped runs are counted and logged.
  A full tenant queue postpones by `SCHEDULER_POSTPONE_MS` without blocking other tenants.
- **Time zones:** `cron-parser` lists wall-clock times in UTC and `src/scheduler/zoned-cron.ts` maps them
  to the zone with `Intl` offsets: with a fixed hour a missing time moves forward and a repeated one runs
  once; with `*` or `*/n` hours the schedule follows elapsed time. Tested over two years in 17 zones,
  including 30-minute, 2-hour and midnight changes.
- **Why:** the row lock and the unique key each prevent a second run on their own.
- **Alternatives:** leader election with an advisory lock (one busy instance, failover waits for the session).
- **Limits:** the start moment depends on the scheduler host clock; crons more often than once a minute
  are refused.

### 3.3.9–3.3.11 Notifications, observability, frontend
- **Outbox:** a row in the transaction of every final status; the dispatcher claims with `SKIP LOCKED`,
  per-tenant turns and at most `OUTBOX_TENANT_CONCURRENCY` in flight, posts through the SSRF guard, signs
  like a webhook with separate secrets, retries with backoff.
- **Observability:** `x-request-id` becomes `executions.correlationId`, is logged by workers with tenant,
  execution, job, attempt and step, and sent as `X-Correlation-Id`; pino JSON logs with secrets redacted;
  metrics `flowforge_queue_depth{tenant_id,status}`, `flowforge_job_claim_latency_seconds`,
  `flowforge_step_duration_seconds`, `flowforge_job_retries_total`, `flowforge_jobs_dead_total` and more.
- **Live updates:** SSE through the Next.js proxy, fed by `pg_notify` triggers for executions that a stream
  watches (`execution_watches`); snapshots leave out outputs over 8 KiB (full value at
  `/executions/{id}/output`, `/executions/{id}/steps/{index}/output`), streams of one execution share one
  read, a slow client gets only the latest snapshot; the listener pings its connection.
- **Frontend:** the page closes its stream on unmount and on a final status and reconnects with backoff;
  executions list with cursor pages and filters; workflow form with the API rules; loading, empty and
  error states; CSP and `no-store` proxy answers.
- **Retention:** workers delete data finished more than `RETENTION_DAYS` (30) ago and unused versions.

## Findings

Every finding has a reproduction that fails on the commit that adds it and passes on the next one (the
fix); `scripts/prove-finding.sh F-NN` checks both. Lines refer to `initial commit` (`5acc271`); paths are
under `apps/api` unless they start with `apps/` or name a root file. F-21 (non-atomic transitions) is
part of F-18.

### F-01 · Any tenant can read any execution by id · Tenant isolation · Critical
- **What:** `src/executions/executions.controller.ts:31-34`, `src/executions/executions.service.ts:33-37` look up by id only.
- **Why dangerous:** any API key reads another tenant's input, output and step results.
- **Reproduce:** `test/integration/findings/F-01-execution-detail-isolation.int-spec.ts`.
- **Fix** (`c77c536`): lookup by `(id, tenantId)`, row level security on top.
- **Alternatives:** checking the owner in each controller (easy to forget).

### F-02 · Tenant isolation unit test cannot fail · Tests that pass regardless · Medium
- **What:** `test/executions.service.spec.ts:8,23-26` mocks the repository to return `[]` and expects `[]`.
- **Why dangerous:** green for any implementation, including one that returns every tenant's data.
- **Reproduce:** `scripts/prove-finding.sh F-02` runs `scripts/mutation/F-02.sh` (removes the tenant filter of the starter query) at both commits: the old test stays green, the new one fails. Later code has a different query and row level security, so on it the script stops with an error.
- **Fix** (`0bc710c`): `test/integration/findings/F-02-execution-list-isolation.int-spec.ts` with two tenants on a real database; red under the same mutation.
- **Alternatives:** asserting mock arguments (still tied to the implementation).

### F-03 · Concurrent workers execute the same job several times · Queue, several workers · Critical
- **What:** `src/engine/job-queue.service.ts:17-34`: `SELECT`, then `UPDATE` by id without a lock or status check.
- **Why dangerous:** slots polling at the same moment take the same job, so payments or emails in http steps repeat.
- **Reproduce:** `test/integration/findings/F-03-exactly-once-claim.int-spec.ts` (4 workers × 4 slots, 60 jobs).
- **Fix** (`7f29ccb`): one `UPDATE ... FOR UPDATE SKIP LOCKED` in `claim_job`.
- **Alternatives:** advisory locks; optimistic `WHERE status = 'queued'` with retries.

### F-04 · Jobs of a crashed worker are never recovered · Worker crash · Critical
- **What:** `src/engine/job-queue.service.ts:6,17-21` never looks at `lockedUntil`; `src/engine/job-runner.service.ts:36-50` never renews the lease.
- **Why dangerous:** a killed worker leaves its jobs `running` forever.
- **Reproduce:** `test/integration/findings/F-04-lease-recovery.int-spec.ts`.
- **Fix** (`99f8e63`): heartbeat, reaper (`queued`, or `dead` with a failed execution), fencing.
- **Alternatives:** a transaction or advisory lock held per job (cannot span a delay).

### F-05 · A stopping worker abandons its current job · Worker crash · High
- **What:** `src/engine/job-runner.service.ts:32-34` only sets `running = false`.
- **Why dangerous:** every deploy strands in-flight jobs.
- **Reproduce:** `test/integration/findings/F-05-graceful-shutdown.int-spec.ts` (SIGTERM to a real worker process mid-step).
- **Fix** (`25432ff`): stop claiming, wait up to 25 s (compose `stop_grace_period` is 30 s), release the rest.
- **Alternatives:** only waiting or only releasing.

### F-06 · A job whose workflow was deleted hangs forever · Poison jobs · High
- **What:** `src/engine/job-runner.service.ts:53-54` loads with `findOneOrFail` outside the `try`; `src/workflows/workflows.service.ts:55-58` deletes workflows that have queued runs.
- **Why dangerous:** the job stays `running` and the execution `pending` forever.
- **Reproduce:** `test/integration/findings/F-06-poison-job.int-spec.ts`.
- **Fix** (`3d91407`): a missing execution, workflow or version fails the job with a reason.
- **Alternatives:** forbidding deletion while runs are queued.

### F-07 · Transform steps run arbitrary code on the host · Step security · Critical
- **What:** `src/engine/step-executor.ts:30-37` uses `new Function`.
- **Why dangerous:** `process.env` (database credentials, admin token), `child_process`; `while(true){}` blocks the worker.
- **Reproduce:** `test/integration/findings/F-07-transform-sandbox.int-spec.ts`.
- **Fix** (`55505f6`): QuickJS sandbox ([3.3.6](#336-safe-step-execution)).
- **Alternatives:** `vm`, `isolated-vm`, an expression language.

### F-08 · Http steps can reach internal addresses · Step security · Critical
- **What:** `src/engine/step-executor.ts:39-46` fetches any URL and follows redirects.
- **Why dangerous:** cloud metadata, Postgres and the API in the compose network, loopback services.
- **Reproduce:** `test/integration/findings/F-08-ssrf.int-spec.ts` (six loopback notations and a redirect from an allowed host). Private ranges, cloud metadata, IPv6 and DNS rebinding are covered by `test/safe-http.spec.ts`, which was added with the fix and therefore was never red.
- **Fix** (`59434fe`): guarded undici agent ([3.3.6](#336-safe-step-execution)).
- **Alternatives:** filtering agents for `http.Agent`, an egress proxy.

### F-09 · Step results are read and stored without a size limit · Resource limits · High
- **What:** `src/engine/step-executor.ts:47` (`res.text()`), `:18` (log), `src/engine/job-runner.service.ts:68` (output).
- **Why dangerous:** one huge response exhausts the worker's memory; huge outputs bloat the database.
- **Reproduce:** `test/integration/findings/F-09-response-size-limits.int-spec.ts`.
- **Fix** (`0c154e4`): `content-length` check, streaming cap, output cap, log cap; non-retryable.
- **Alternatives:** silent truncation.

### F-10 · Input values can rewrite the url of an http step · Step security · High
- **What:** `src/engine/template.ts:16-21` inserts values as they are; `src/engine/step-executor.ts:40` renders the URL.
- **Why dangerous:** `https://api.example.com{{ input.p }}` with `p="@169.254.169.254/"` changes the host.
- **Reproduce:** `test/integration/findings/F-10-url-template-injection.int-spec.ts`.
- **Fix** (`ee31917`): percent-encoding, fixed origin required and re-checked, lookups on own properties only.
- **Alternatives:** no placeholders in URLs; checking only the host.

### F-11 · Webhook signatures are checked against a re-serialized body · Webhook authenticity · High
- **What:** `src/webhooks/webhooks.controller.ts:31` signs `JSON.stringify(parsed body)`.
- **Why dangerous:** signatures over the real bytes fail; different bodies share a signature; non-JSON is verified as `{}`.
- **Reproduce:** `test/integration/findings/F-11-raw-body-signature.int-spec.ts`.
- **Fix** (`b791793`): HMAC over the raw bytes; `415` for non-JSON.
- **Alternatives:** canonical JSON.

### F-12 · Webhook signatures are compared with a timing leak · Webhook authenticity · Medium
- **What:** `src/webhooks/webhooks.controller.ts:32` uses `!==`.
- **Why dangerous:** response time reveals how much of a guessed signature is right.
- **Reproduce:** `test/integration/findings/F-12-constant-time-signature.int-spec.ts`.
- **Fix** (`3cf2c69`): base64 decode, fixed 32-byte length, `timingSafeEqual`.
- **Alternatives:** comparing HMACs of both values.

### F-13 · Replayed and stale webhooks start new executions · Webhook redelivery · High
- **What:** `src/webhooks/webhooks.controller.ts:20-38`: no timestamp, window or deduplication.
- **Why dangerous:** a captured request can be replayed at any time; a sender's retry runs the workflow twice.
- **Reproduce:** `test/integration/findings/F-13-webhook-replay.int-spec.ts` (replay, retry with a fresh timestamp, 10 concurrent duplicates).
- **Fix** (`f9ee8af`): id and timestamp in the signature, tolerance window, unique trigger key.
- **Alternatives:** a seen-ids table with expiry.

### F-14 · Every scheduler instance fires the same occurrence · Scheduler, several instances · High
- **What:** `src/scheduler/scheduler.service.ts:19-22,29-46` runs in every API instance (`src/app.module.ts:29`) without coordination.
- **Why dangerous:** N replicas run each cron workflow N times.
- **Reproduce:** `test/integration/findings/F-14-scheduler-multi-instance.int-spec.ts`.
- **Fix** (`cc545b7`): scheduler process, row-locked claim, unique trigger keys.
- **Alternatives:** leader election; the unique key alone.

### F-15 · Schedules ignore their time zone · Scheduler, time zones · High
- **What:** `src/scheduler/scheduler.service.ts:38` calls `parseExpression` without `tz`.
- **Why dangerous:** runs in the time zone of the process (UTC in Docker) and ignores DST of the tenant.
- **Reproduce:** `test/integration/findings/F-15-schedule-time-zones.int-spec.ts` (winter, summer, spring gap, autumn repeat).
- **Fix** (`206afc7`): the workflow's `tz`; time zones validated.
- **Alternatives:** another cron library.

### F-16 · Runs missed while the scheduler is down are lost · Scheduler, restart · High
- **What:** `src/scheduler/scheduler.service.ts:12` keeps `lastTick` in memory; `:43-47` moves it on after an enqueue error.
- **Why dangerous:** downtime or a failed enqueue silently drops runs.
- **Reproduce:** `test/integration/findings/F-16-missed-runs-after-restart.int-spec.ts`.
- **Fix** (`91a7b34`): persistent `nextRunAt`, moved only with the enqueue; missed-run policies.
- **Alternatives:** persisting `lastTick` per instance.

### F-17 · A slow scheduler tick overlaps the next and fires twice · Scheduler, restart · Medium
- **What:** `src/scheduler/scheduler.service.ts:21` uses `setInterval` with an async tick.
- **Why dangerous:** a tick slower than the interval overlaps the next one with the same `lastTick`.
- **Reproduce:** `test/integration/findings/F-17-overlapping-ticks.int-spec.ts`.
- **Fix** (`ab5eea8`): ticks chained with `setTimeout`.
- **Alternatives:** a "running" flag.

### F-18 · A retry repeats steps that already succeeded · Execution properties · Critical
- **What:** `src/engine/job-runner.service.ts:60-64` starts from step 0 on every attempt; `:56-91` updates three tables in separate statements.
- **Why dangerous:** a failure in a later step repeats earlier side effects; a crash between statements leaves, for example, a `succeeded` execution with a `running` job.
- **Reproduce:** `test/integration/findings/F-18-resume-from-checkpoint.int-spec.ts` proves the repeated steps. The non-atomic transitions (F-21) are proven by mutation: `scripts/mutation/starter-defects.sh non-atomic-completion` splits the completion back into two transactions as in the starter, and `outbox/notifications.int-spec.ts` ("same transaction as the final state"), green on the current code, fails because the job is `done` while the execution is not.
- **Fix** (`b02e231`): fenced per-step checkpoints, one transaction per transition, idempotency keys.
- **Alternatives:** event sourcing; requiring idempotent steps from users.

### F-19 · A running execution picks up edits of its workflow · Execution properties · High
- **What:** `src/engine/job-runner.service.ts:54` loads the current workflow; `src/workflows/workflows.service.ts:45-48` keeps no history.
- **Why dangerous:** one execution mixes steps of two versions.
- **Reproduce:** `test/integration/findings/F-19-workflow-version-snapshot.int-spec.ts`.
- **Fix** (`4847db6`): immutable `workflow_versions`.
- **Alternatives:** copying steps into executions.

### F-20 · A delay holds a worker slot and restarts after a crash · Execution properties · High
- **What:** `src/engine/step-executor.ts:20-22` uses `setTimeout`.
- **Why dangerous:** a 1 h delay blocks a slot for an hour; a restart starts the execution over.
- **Reproduce:** `test/integration/findings/F-20-durable-delay.int-spec.ts`.
- **Fix** (`a762382`): durable timers ([3.3.3](#333-durable-timers)).
- **Alternatives:** a separate timers table.

### F-22 · The execution page polls forever and leaks its timer · Client that degrades · Medium
- **What:** `apps/frontend/app/executions/[id]/page.tsx:11-16`: `setInterval` without cleanup.
- **Why dangerous:** every visit adds a timer that never stops, requests overlap, errors show "Loading…" forever.
- **Reproduce:** `apps/frontend/test/findings/F-22-execution-page-updates.test.tsx`.
- **Fix** (`09fc220`): SSE with cleanup, stop on a final status, error and reconnect states.
- **Alternatives:** fixing the polling.

### F-23 · Input is not validated at the API boundary · Validation · Medium
- **What:** `src/workflows/workflows.service.ts:7-13,29` takes an interface; `src/executions/executions.controller.ts:27-28` uses `Number(limit)`.
- **Why dangerous:** a missing `name` or `limit=abc` answers `500`; invalid cron or time zone is stored; `* * * * * *` runs every second.
- **Reproduce:** `test/integration/findings/F-23-input-validation.int-spec.ts`.
- **Fix** (`b503556`): DTO classes, query DTO, cron and time zone checks, definition limits.
- **Alternatives:** one JSON schema for the definition.

### F-24 · Webhook responses reveal which workflows exist · Webhook authenticity · Low
- **What:** `src/webhooks/webhooks.controller.ts:27-28`: `404` for unknown or disabled workflows, `401` for a bad signature.
- **Why dangerous:** workflow ids can be probed without a secret.
- **Reproduce:** `test/integration/findings/F-24-webhook-enumeration.int-spec.ts`.
- **Fix** (`a8280f7`): the same `401` for all three cases.
- **Alternatives:** equalising response time as well.

### F-25 · API runs as a database superuser and accepts a placeholder admin token · Security, configuration · High
- **What:** `docker-compose.yml:4-7` and `.env.example:2` connect as the superuser, `src/app.module.ts:22` has `synchronize: true`, `.env.example:3` is a placeholder `ADMIN_TOKEN`.
- **Why dangerous:** any injection owns the database, row level security is impossible, the schema changes on start, anyone can create tenants.
- **Reproduce:** `test/integration/findings/F-25-least-privilege.int-spec.ts`.
- **Fix** (`02fd4b4`): owner and app roles, migrations, a config check that refuses a placeholder token in production.
- **Alternatives:** one non-superuser role for everything.

### F-26 · A NUL character makes data impossible to store · Validation, storage · Medium
- **What:** Postgres cannot store `\u0000`; request bodies (`src/main.ts:6`) and step results (`src/engine/job-runner.service.ts:68,70`) are not checked.
- **Why dangerous:** `500` with a database error; a response with NUL fails every attempt.
- **Reproduce:** `test/integration/findings/F-26-nul-characters.int-spec.ts`.
- **Fix** (`2c7af7b`): `400` for such bodies, U+FFFD in stored results.
- **Alternatives:** storing outputs as `bytea`.

### F-27 · Deeply nested JSON crashes the API and poisons steps · Resource limits · Medium
- **What:** `src/main.ts:6` and `src/engine/job-runner.service.ts:68` accept any nesting.
- **Why dangerous:** stack overflow answers `500`; such a step response fails every attempt.
- **Reproduce:** `test/integration/findings/F-27-deeply-nested-json.int-spec.ts`.
- **Fix** (`e23b2a1`): iterative depth check (64) of bodies (`400`) and outputs (non-retryable).
- **Alternatives:** catching `RangeError`.

### F-28 · One tenant's backlog delays every other tenant · Fairness · High
- **What:** `src/engine/job-queue.service.ts:19` claims in global `runAt` order.
- **Why dangerous:** other tenants wait for the whole backlog (p95 31 s in the load test).
- **Reproduce:** `test/integration/findings/F-28-noisy-neighbour.int-spec.ts`, `npm run load:fairness`.
- **Fix** (`e33c796`): round-robin claim ([3.3.5](#335-fair-scheduling)).
- **Alternatives:** per-tenant queues; random tenant choice.

### F-29 · Input values can inject fields into an http step body · Step security · High
- **What:** `src/engine/step-executor.ts:44` renders the body without encoding.
- **Why dangerous:** `{"name": "{{ input.name }}"}` with `x", "role": "admin` adds a field; `x&role=admin` does it in a form.
- **Reproduce:** `test/integration/findings/F-29-body-template-injection.int-spec.ts`.
- **Fix** (`e2a9f3f`): values encoded for the body format (JSON string, JSON value, form).
- **Alternatives:** a structured body object; no placeholders in bodies.

### Defects in code written during this work

Three code reviews after the findings found defects in the new code, not in the starter. Each review is
fixed in one commit with tests that failed before it: `fix: resolve defects found in the final code
review`, `... second code review`, `... third code review`. The main ones:

- **Queue and durability:** unfenced `running` writes, the reaper leaving steps `running`, a failure
  record replacing the step error, attempts counted per execution instead of per step, no backoff after
  a lost lease, a lost lease noticed 20 s late, retries sending other body bytes with the same key, a due
  `delay` always parked again, unbounded total outputs per job, a pool too small for heartbeats.
- **Isolation and boundary:** no check of the database role, writable `migrations`/`tenants`/versions,
  unranged tenant limits, form-encoded and UTF-16 bodies bypassing the NUL and depth checks, `..` in url
  values, unescaped `text/json` bodies, a sandbox result copied out before its size check, database work
  for every forged request.
- **Resources:** full outputs in execution details and every stream snapshot, a read per stream per
  change, no backpressure, unbounded lists, versions and finished data, slow cron validation, an unbounded
  time-zone cache, a notification lock on every commit, a LISTEN connection never checked.
- **Scheduler and outbox:** clock changes at midnight or of 30 minutes, a full tenant queue delaying
  every schedule, a hanging endpoint holding the dispatcher.
- **Frontend and operations:** forms refusing what the API accepts, cacheable proxy answers, a long
  insecure cookie, no security headers, endless reconnects, no restart policy, CI that never started the
  stack, dependencies with known advisories, tests that could not fail.

### Starter defects fixed without a reproduction

These were fixed while building a feature, so no commit holds a red test for them. They are proven by
mutation instead: `scripts/mutation/starter-defects.sh [mutant]` copies the app, checks that the test
passes, puts the starter defect back and requires the same test to fail (all six mutants are killed).

| Defect (starter) | Why dangerous | Fix | Test · mutant | Alternative |
|---|---|---|---|---|
| No database timeouts (`src/app.module.ts:18-23`) · Resources · High | a paused or locked Postgres makes every request and worker hang | `987ffa7`: connect, statement and client timeouts | `db/timeouts.int-spec.ts` · `database-timeouts` | timeouts per query |
| Admin token checked after the body was validated (`src/tenants/tenants.controller.ts:27-31`) · Security · Low | anyone learns the admin API from `400` answers | `987ffa7`: a guard runs before validation | `tenancy/admin-endpoint.int-spec.ts` · `admin-token-after-validation` | a separate admin port |
| Frontend proxy without a deadline (`apps/frontend/app/api/proxy/[...path]/route.ts`) · Resources · Medium | a hanging API holds frontend requests forever | `24bcf46`: `AbortSignal.timeout`, `504` | `apps/frontend/test/proxy-route.test.ts` · `proxy-without-timeout` | a timeout in the reverse proxy |
| Frontend proxy forwards any path segment (same file) · Security · Medium | `..` or encoded segments reach API routes the UI never calls | `24bcf46`: segments must match `[A-Za-z0-9_-]+` | `proxy-route.test.ts` · `proxy-without-path-check` | an allowlist of routes |
| `/api/connect` without an origin check (`apps/frontend/app/api/connect/route.ts`) · Security · Medium | another site posts its own key (login CSRF), the user then acts in the attacker's tenant | `24bcf46`: `Origin` must match | `connect-route.test.ts` · `connect-without-origin-check` | a CSRF token |
| Non-atomic transitions (F-21, part of [F-18](#f-18--a-retry-repeats-steps-that-already-succeeded--execution-properties--critical)) | a crash between statements leaves a `done` job with a `running` execution | `b02e231`: one fenced transaction per transition | `outbox/notifications.int-spec.ts` · `non-atomic-completion` | — |

## Indexes and query plans

| Query | Index |
|---|---|
| Tenants with queued jobs / oldest ready job of a tenant / queue limit | `IDX_jobs_queued_by_tenant (tenantId, runAt) WHERE status='queued'` |
| Running jobs of a tenant, expired leases | `IDX_jobs_running_by_tenant`, `IDX_jobs_expired_leases (lockedUntil)` (partial on `running`) |
| Executions of a tenant, newest first, by status, by workflow | `IDX_executions_tenant_created`, `_tenant_status_created`, `_tenant_workflow_created` (all end with `createdAt, id`) |
| Workflows of a tenant, newest first | `IDX_workflows_tenant_created (tenantId, createdAt, id)` |
| Idempotency of webhooks and cron | `UQ_executions_tenant_trigger_key (tenantId, triggerKey) WHERE NOT NULL` |
| Checkpoints, version snapshot | `UQ_step_runs_execution_step`, `UQ_workflow_versions_workflow_version` |
| Next due schedule | `IDX_workflows_due (COALESCE(scheduleRetryAt, nextRunAt))` (partial) |
| Due notifications, abandoned deliveries, notifications by state | `IDX_outbox_events_pending_by_tenant`, `_expired_leases`, `_tenant_status_created` |
| Retention | `IDX_executions_finished`, `IDX_executions_unfinished_version`, `IDX_outbox_events_finished`, `IDX_jobs_execution` |

**How verified:** `test/integration/db/query-plans.int-spec.ts` loads 50 tenants, 5 000 workflows,
100 000 executions and jobs, 160 000 step runs and 50 000 notifications plus a tenant with 10 000 sleeping
jobs, calls the real services as the application role and reads every plan through `auto_explain`, also
inside the PL/pgSQL functions. It requires the expected index, no sequential scan of a large table, no
sort of more than one page and, for claims, fewer than 1 000 rows thrown away by a filter; removing an
index fails it. `QUERY_PLAN_REPORT=plans.md npx jest query-plans` writes the measured times.

## Tests, chaos and load

```bash
cd apps/api && npm ci && npm run lint && npm run typecheck
npm run test:unit                # 410 tests, no database
npm run test:int                 # 381 tests, Postgres 16 via Testcontainers (Docker)
cd ../frontend && npm ci && npm run lint && npm test && npm run build   # 93 tests
cd ../.. && scripts/prove-finding.sh F-03    # red before the fix, green after it
scripts/mutation/starter-defects.sh          # starter defects without a red commit, by mutation
```

Each integration test file gets its own database cloned from a migrated template. `TEST_DATABASE_URL`
(a superuser URL) uses an existing server instead of a container: it drops and recreates `ff_template`,
`ff_template_empty` and `ff_t_*` databases, needs `psql` on the host, and creates the roles with
`TEST_OWNER_PASSWORD`/`TEST_APP_PASSWORD` (default: the role names) if they are missing. CI runs all of
the above except `prove-finding.sh` and the mutation scripts, audits production dependencies, builds the images, starts the stack
and runs `scripts/smoke.sh`.

| Requirement (task 6) | Tests |
|---|---|
| Backoff, definition validation, sandbox, webhook signature, cron in time zones and on DST dates | `test/retry-backoff.spec.ts`, `definition.spec.ts`, `sandbox.spec.ts`, `webhook-signature.spec.ts`, `cron-schedule.spec.ts` |
| N workers × M jobs, each exactly once | F-03 |
| Worker killed mid-step: picked up, finished steps not repeated, side effect once | `integration/chaos/worker-killed-mid-step.int-spec.ts`, F-04, F-18 |
| Two scheduler instances, one run | F-14, `scheduler/scheduling.int-spec.ts` |
| Tenant A cannot see or change B, also bypassing services | `tenancy/row-level-security.int-spec.ts`, `tenancy/api-isolation.int-spec.ts`, F-01, F-02 |
| SSRF, sandbox escape, webhook replay, changed body | `safe-http.spec.ts`, F-07, F-08, F-11, F-13 |
| OpenAPI document matches the API | `api/openapi.int-spec.ts` (routes, response fields, request bodies, query parameters, enums, status codes) |

### Chaos: all workers killed in the middle of a payment

```bash
docker compose -p flowforge -f docker-compose.yml -f docker-compose.chaos.yml up -d --build
cd apps/api && npm run chaos:kill-workers
```

The overlay adds `sink` (`docker/chaos/sink.js`), which applies each effect once per `Idempotency-Key`,
holds the first `/charge` for 6 s and records notifications, and lets workers reach it through
`SSRF_ALLOWLIST`. The script runs 10 executions of `reserve → charge → delay 2 s → email` with a
notification endpoint, sends SIGKILL to both workers while charges are in flight, restarts them and
exits with an error if any guarantee is broken. Result, the same on every run (Apple M1, Docker 8 CPUs):

| Finished after the kill | Succeeded | reserve: attempts / requests / effects | charge | email | Notifications |
|---|---|---|---|---|---|
| 35.2–35.8 s | 10 / 10 | 10×1 / 10 / 10 | 2×1 + 8×2 / 18 / 10 | 10×1 / 10 / 10 | 10, all distinct ids |

Killed jobs come back after the 30 s lease and the next reaper pass; interrupted charges ran again with
the same key and were applied once; the reserve step was not repeated. With an idempotency key that
changes per attempt, or with checkpoints ignored, the script fails.

### Load: fair scheduling

```bash
cd apps/api && npm run load:fairness
```

Tenant A enqueues 20 000 executions while workers are stopped; then workers start and tenants B and C
start one execution per second for 60 s. Latency is from creation to the start of the first step.
Baseline: the same scenario on the code before the fix (`e1c84fc`). 2 workers × 4 slots, Apple M1,
Docker 8 CPUs.

| Claim order | B and C while A's backlog drains: p50 / p95 / p99, ms | After it drained: p95, ms |
|---|---|---|
| FIFO (baseline) | 16 161 / 31 139 / 32 115 | 238–243 |
| Round-robin | 15–16 / 35–44 / 743–766 | 222–238 |

The backlog drained at 454 jobs/s on the current code and 622 jobs/s on the baseline, which also lacks
everything added after it (live update triggers, outbox, logging context, metrics, limits), so the
difference is not the cost of the fair claim alone.

## Changes to existing tests

| File | Change | Reason |
|---|---|---|
| `apps/api/test/executions.service.spec.ts` (starter) | removed | could not fail (F-02), replaced by a real test |
| `apps/api/test/job-queue.spec.ts` (starter) | removed two `it.todo` | implemented by F-03 and F-04 |
| `findings/F-09-*` | 256 KiB output and a 64 KiB limit instead of 8 MB | 8 MB timed out the transform limit under load |
| `findings/F-12-*` | tampers with the signature header only | the F-13 fix added more headers that hid what F-12 checks |
| `tenancy/tenant-limits.int-spec.ts` | no `429` expected among concurrent requests | the queue limit is soft by design |
| `findings/F-20-*`, `execution/checkpoints`, `queue/lease` | wait for a state instead of a fixed time | fixed sleeps were flaky |
| `apps/frontend/test/findings/F-22-*` | two assertions check connections and requests after failures | they passed whatever the page did |
| `body-template.spec.ts` | JSON-looking `text/plain` and `application/jsonp` bodies are JSON | such bodies are escaped now |
| `cron-schedule.spec.ts`, `sandbox.spec.ts`, `config.spec.ts`, `db/query-plans`, `outbox/notifications`, `observability/metrics`, `tenancy/row-level-security` | new names, settings, tables and plan checks | the behaviour they cover was extended |
| `api/openapi.int-spec.ts`, `tenancy/admin-endpoint.int-spec.ts`, frontend route and page tests, `apps/frontend/test/workflow-form.test.ts` | Express 5 router, request built in one expression, Next.js 15 promise params, `validateWorkflow(values, original)` | framework upgrades, typed lint, the form follows the API rules |
| `test/support/*` | `bodyParser: false`, workers start retention, role passwords from env, `SCHEDULER_TICK_MS` 59 s | built like `main.ts`; a tick must be shorter than the 60 s grace window |

The other starter tests are unchanged and green.

## Not done, or done differently

- An egress proxy as a second SSRF barrier; secrets encrypted with a KMS key.
- `Idempotency-Key` for `POST /workflows/:id/run`; manual retry of failed executions; input for Run in the UI.
- Weighted fairness or fairness by CPU time; `LISTEN/NOTIFY` wake-up instead of 250 ms polling.
- The UI keeps the API key in an http-only 12-hour cookie instead of an opaque server-side session.
- `set_tenant_limits` is not limited to a separate admin role (the application role can set any tenant
  context anyway); limits are range checked by the database instead.
- The workflow quota is one setting for all tenants, not part of `PATCH /tenants/:id/limits`.
- Version garbage collection reads the version and workflow tables in full on each retention run.
- Not measured: the effect of watched notifications on commit throughput; outbox in-flight limits can be
  exceeded by one per dispatcher claiming at the same moment.
- The runtime image still contains `typescript` and `ts-node` (peer dependencies of TypeORM); `typeorm`
  0.3 pulls `glob`/`minimatch` with moderate advisories (CI fails on high and critical).
