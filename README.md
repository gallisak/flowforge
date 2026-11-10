# FlowForge — starter repository

A multi-tenant automation platform: a user describes a workflow as a sequence of steps
(`http`, `transform`, `log`, `delay`), runs it manually, via a webhook or on a cron schedule,
and workers execute the steps from a queue in Postgres.

## Layout

- `apps/api` — NestJS: HTTP API (`main.ts`), cron scheduler (runs inside the API process),
  separate worker process (`worker.ts`).
- `apps/frontend` — Next.js (App Router): API key input, workflow list, execution page.
- `docker-compose.yml` — Postgres, one-shot `migrate`, API, two workers, frontend.
- `docker/postgres` — database roles provisioned on first start of the Postgres volume.

## Running

```bash
docker-compose up --build
```

- API: http://localhost:3000, frontend: http://localhost:3001
- Host ports can be changed with `API_PORT`, `WEB_PORT` and `PG_PORT`.
- Start order: Postgres → `migrate` (applies pending migrations, then exits) → API and workers.
  If you have a Postgres volume from before database roles were introduced, recreate it once with
  `docker compose down -v`.

Create a tenant (the token is `ADMIN_TOKEN` from `apps/api/.env.example`):

```bash
curl -X POST localhost:3000/tenants -H 'x-admin-token: change-me-admin' \
  -H 'content-type: application/json' -d '{"name":"acme"}'
```

The response contains `apiKey` (shown only once) and `webhookSecret`. All further requests
use the `x-api-key` header.

## Main endpoints

| Method | Path | Description |
|---|---|---|
| POST/GET/PATCH/DELETE | `/workflows[/:id]` | manage workflows |
| POST | `/workflows/:id/run` | run manually (body is the input) |
| GET | `/executions`, `/executions/:id` | executions and their steps |
| POST | `/hooks/:workflowId` | incoming webhook, signature in `x-signature` (HMAC-SHA256 hex) |

Example workflow:

```json
{
  "name": "demo",
  "steps": [
    { "id": "fetch", "type": "http", "url": "https://example.com/api?q={{ input.q }}" },
    { "id": "shape", "type": "transform", "expr": "ctx.steps.fetch.body" }
  ]
}
```

## Configuration

All settings come from environment variables; `apps/api/.env.example` is the development set used
by docker-compose. Every process validates its settings on start and exits with a list of problems
instead of starting half-configured. Error messages never contain secret values.

| Variable | Used by | Default | Rules |
|---|---|---|---|
| `NODE_ENV` | api, worker | `development` | `development`, `test` or `production` |
| `PORT` | api | `3000` | integer 0..65535 |
| `DATABASE_URL` | api, worker | — | required, `postgres://`, application role |
| `MIGRATION_DATABASE_URL` | migrate | — | required, `postgres://`, migration role |
| `DB_CONNECT_TIMEOUT_MS` | api, worker | `5000` | integer 100..120000; waiting for a pooled connection |
| `DB_STATEMENT_TIMEOUT_MS` | api, worker | `15000` | integer 100..600000; server-side statement timeout, the client gives up 5 s later |
| `ADMIN_TOKEN` | api | — | required; at least 8 characters, in production at least 32 random characters |
| `WORKER_CONCURRENCY` | worker | `4` | integer 1..64 |
| `SCHEDULER_TICK_MS` | api | `30000` | integer 1000..3600000 |
| `WORKER_LEASE_SECONDS` | worker | `30` | integer 2..3600; heartbeat every third of it |
| `WORKER_REAPER_INTERVAL_MS` | worker | `5000` | integer 100..600000 |
| `WORKER_SHUTDOWN_GRACE_MS` | worker | `25000` | integer 0..600000; keep below the container stop timeout |
| `RETRY_BASE_MS` | worker | `1000` | integer 10..600000 |
| `RETRY_CAP_MS` | worker | `300000` | integer, not smaller than `RETRY_BASE_MS` |

## Database

The schema is managed by TypeORM migrations in `apps/api/src/migrations`; `synchronize` is off.
`npm run migrate` (or the `migrate` compose service) applies pending migrations under a Postgres
advisory lock, so several migrators started at once apply each migration exactly once.
`npm run migration:generate -- src/migrations/<Name>` generates a migration from entity changes.

Every database call of the API and the workers is bounded: acquiring a connection
(`DB_CONNECT_TIMEOUT_MS`), a statement on the server (`DB_STATEMENT_TIMEOUT_MS`), the client waiting for
an unresponsive server (statement timeout + 5 s) and a transaction left idle (twice the statement
timeout). When Postgres stops answering, requests fail with a generic `500` instead of hanging.

Two roles are provisioned by `docker/postgres/provision.sql`:

| Role | Purpose | Privileges |
|---|---|---|
| `flowforge_owner` | runs migrations, owns all tables | DDL in schema `public`; not a superuser |
| `flowforge_app` | used by the API and workers | `SELECT/INSERT/UPDATE/DELETE` only; no DDL, not a superuser, no `BYPASSRLS` |

## Tenant isolation

Isolation is enforced twice: every query in the services filters by the authenticated tenant, and
Postgres row level security rejects rows of other tenants even when a query forgets that filter.

- Every tenant table (`tenants`, `workflows`, `executions`, `step_runs`, `jobs`) has row level
  security enabled with one policy: the row's tenant must equal `app_current_tenant()`, which reads
  the transaction-local setting `app.tenant_id`. Without the setting nothing is visible and nothing
  can be written (`USING` and `WITH CHECK`).
- `TenantDb.run(tenantId, work)` (`apps/api/src/db/tenant-db.service.ts`) opens a transaction, sets
  `app.tenant_id` with `set_config(..., true)` and runs the work in it; services access tenant data
  only through it. The setting dies with the transaction, so a pooled connection never carries a
  tenant into the next request.
- A few operations are cross-tenant by nature. They are narrow `SECURITY DEFINER` functions owned by
  the migration role, with a fixed `search_path`, `EXECUTE` revoked from `PUBLIC` and granted only to
  `flowforge_app`, and they return identifiers only: `auth_tenant` (API key hash → id, name),
  `resolve_webhook_tenant` (workflow id → tenant id), `list_scheduled_workflows` and `next_ready_job`.
  Everything after that lookup runs in the tenant's context.
- Proof: `apps/api/test/integration/tenancy/row-level-security.int-spec.ts` connects as the
  application role and bypasses the services: without a context every table is empty (also after a
  previous transaction on the same connection set one), with tenant A's context only A's rows are
  visible, rows of B cannot be updated, deleted, inserted or moved into, and RLS cannot be disabled.
  `api-isolation.int-spec.ts` checks the same through the HTTP API.

| Option | Verdict |
|---|---|
| Filters in application code only | Not enough: one forgotten `where` leaks data (see F-01). |
| Schema or database per tenant | Strong isolation, but migrations, pooling and the shared queue become much harder; out of proportion for this platform. |
| RLS with a session-level `SET` | A pooled connection can keep the previous tenant; a transaction-local setting cannot. |
| Worker role with `BYPASSRLS` | Simpler queue code, but the worker would process tenant data without any database guard. |
| **RLS + transaction-local setting + narrow definer functions** | Chosen. |

Limitations: row level security protects against bugs in the application, not against SQL
injection, because injected SQL could set `app.tenant_id` itself; queries stay parameterised. The
migration role owns the tables and therefore bypasses the policies; it is used only by `migrate`.
Each tenant operation is its own short transaction, which costs one extra round trip.

## Job queue

The queue is the `jobs` table. One job drives one execution.

```
                  claim_job (SKIP LOCKED)            complete (fenced)
  queued ─────────────────────────────▶ running ─────────────────────▶ done
    ▲  ▲                                 │  │  │
    │  └──── retryable error, attempts   │  │  └─ non-retryable error ──▶ failed
    │        left: runAt = now + backoff │  └──── retryable error, no attempts left ──▶ dead
    │                                    │
    └──── shutdown release / lease expired (reaper) ── lease expired, no attempts left ──▶ dead
```

- **Claiming** — `claim_job(worker, lease)` selects the oldest due job with `FOR UPDATE SKIP LOCKED`
  and marks it `running` in the same statement, so concurrent workers never get the same job and
  never wait for each other. It increments `attempts`, which also serves as a fencing token.
- **Lease and heartbeat** — a claimed job is owned until `lockedUntil`. The worker extends it every
  third of `WORKER_LEASE_SECONDS`. When the database answers that the job is no longer owned, or when
  no extension has succeeded for a whole lease, ownership is gone and the running step is aborted; a
  renewal that fails because of a short database hiccup is retried on the next beat.
- **Recovery** — every worker runs `reap_expired_jobs()` every `WORKER_REAPER_INTERVAL_MS`: jobs whose
  lease expired go back to `queued`, or to `dead` when they have no attempts left (a job that crashes
  its worker every time cannot loop forever); a dead job and its failed execution are written in the
  same statement.
- **Fencing** — extending, completing, failing and releasing a job are conditional on the same
  `lockedBy` and `attempts`; completion updates the job and its execution in one transaction. A worker
  that lost its lease cannot overwrite the result of the worker that took over.
- **Retries** — errors are classified: HTTP 5xx, 408, 425, 429, connection errors and timeouts are
  retryable; other 4xx, invalid expressions and missing workflows are not. A retryable failure is
  rescheduled after `random(base, min(cap, base · 2^attempt))` ms (exponential backoff with jitter, so
  jobs that failed together do not retry together); after `maxAttempts` the job becomes `dead`. A
  non-retryable failure goes straight to `failed`. In both cases the execution is `failed` with the
  error.
- **Graceful shutdown** — on `SIGTERM` the worker stops claiming, waits up to
  `WORKER_SHUTDOWN_GRACE_MS` for running jobs, then aborts the rest and releases them to `queued`
  without counting the attempt.

| Option | Verdict |
|---|---|
| `SELECT ... FOR UPDATE SKIP LOCKED` + lease columns | **Chosen**: one statement, state visible in the table, survives any process crash, indexable. |
| `FOR UPDATE` without `SKIP LOCKED` | Correct but serialises all workers on the head of the queue. |
| Optimistic `UPDATE ... WHERE status = 'queued'` | Correct, but under contention most claims lose and retry. |
| Session advisory locks as ownership | Released automatically on disconnect, but invisible in the table and requires holding a connection for the whole job. |
| `LISTEN/NOTIFY` as the queue | Not durable; useful only as a wake-up signal. |
| Redis / RabbitMQ | Out of scope by the task: the queue must live in Postgres. |

Limitations: claim order is global FIFO by `runAt` (per-tenant fairness comes with tenant limits);
idle workers poll every 250 ms.

## Durable execution

- **Version snapshot** — every change of a workflow's steps writes an immutable row to
  `workflow_versions`; an execution records the version current when it was enqueued and the worker
  reads the steps only from that snapshot. Editing a workflow never changes executions that already
  exist; deleting it cancels the unfinished ones.
- **Checkpoints** — each step has exactly one `step_runs` row (unique `(executionId, stepIndex)`) with
  its status, output, error, number of attempts and timestamps. On every attempt the worker rebuilds
  `ctx.steps` from the outputs of succeeded steps and continues at the first step without a successful
  checkpoint; a finished step is never recomputed.
- **Fencing** — starting a step, recording its result and recording its failure each run in one
  transaction that first locks the job row and checks that this worker still owns it (`lockedBy` and
  `attempts`). Completing the execution updates the job and the execution together.
- **Idempotency keys** — every request of an `http` step carries `Idempotency-Key:
  <executionId>:<stepId>`, identical for all attempts of that step in that execution and different for
  any other step or execution; a key set by the tenant on the step is replaced. The key is stored on the
  checkpoint.
- **Durable timers** — a `delay` step stores `wakeAt` on its checkpoint, sets the execution to
  `waiting` and returns the job to the queue with `runAt = wakeAt` without counting an attempt, so it
  occupies no worker slot. The step completes on the first claim after `wakeAt` by the database clock.

### Guarantees

| Unit | Guarantee | Conditions and windows |
|---|---|---|
| `transform`, `log` step | Executed at least once; its recorded result is final once committed | A worker that dies or loses its lease after computing but before committing the checkpoint causes one more execution (a log line may appear twice). |
| `http` step | Delivered at least once; **effectively once** for receivers that deduplicate by `Idempotency-Key` | A second delivery happens when the worker dies, loses its lease or times out after the request left and before the checkpoint was committed. Every delivery of the step carries the same key. |
| `delay` step | Wakes up no earlier than `wakeAt`, exactly once | Late by the claim interval (≤ 250 ms when a worker is idle) plus queue wait. Survives restarts and crashes. |
| Execution | Uses one workflow version; reaches `succeeded` or `failed` at most once; every step result is committed at most once | Requires at least one running worker. `failed` after a non-retryable error, after `maxAttempts` retryable failures, or when its workflow is deleted. |
| Job | Owned by at most one worker at a time | Ownership lasts `WORKER_LEASE_SECONDS` and is renewed by heartbeat; an expired lease is reclaimed by the reaper. |

The chaos test `apps/api/test/integration/chaos/worker-killed-mid-step.int-spec.ts` demonstrates the
table: a worker process is killed with `SIGKILL` while the receiver holds the second of three HTTP
steps; another worker reclaims the job after the lease expires, does not repeat the first step,
repeats the interrupted step with the same key, and a receiver that honours the key applies each of
the three effects once.

| Decision | Options considered | Chosen |
|---|---|---|
| Version snapshot | copy steps into each execution; forbid edits while running; **versions table** | Versions table: one copy per version, full history, cheap reference from executions. |
| Checkpoints | append-only attempt log; results in the job row; event sourcing; **one row per step** | One row per step with an attempt counter: the current state is a single lookup and the history needed for debugging is kept. |
| Idempotency key | random per attempt (useless for dedupe); hash of the request body (changes when templates render differently); **execution + step id** | Stable, readable, unique per step and execution. |
| Timers | in-memory sleep; `pg_sleep`; separate timers table; **queue `runAt`** | The queue already is a durable timer. |

## Tests

```bash
cd apps/api && npm ci
npm run test:unit   # no database needed
npm run test:int    # real Postgres 16 via Testcontainers, requires Docker
npm test            # both
```

Integration tests build the database exactly like production: the same `provision.sql`, the same
migrations, and the application connects as `flowforge_app`. Each test file gets its own database
cloned from a prepared template.

## Findings

Every finding is reproduced by an automated test or script that fails on the code before the fix
and passes after it. Each finding is two consecutive commits: the first adds the reproduction
(red), the second fixes the code (green). `scripts/prove-finding.sh F-NN` checks both states
automatically in throwaway git worktrees. Line references point to the `initial commit`.

### F-01 · Any tenant can read any execution by id · Tenant data isolation · Critical

- **What:** `apps/api/src/executions/executions.controller.ts:31-34` and
  `apps/api/src/executions/executions.service.ts:33-36`. `GET /executions/:id` is protected by the API
  key guard, but the controller never passes the caller's tenant to the service, and the service looks
  the execution up by `id` only.
- **Why it is dangerous:** any tenant with a valid API key can read the input, output, error and step
  results of every other tenant's executions, which typically contain customer data and tokens passed
  to workflows. Execution ids leak easily (logs, webhooks, support tickets) and are the only thing an
  attacker needs.
- **How to reproduce:** `apps/api/test/integration/findings/F-01-execution-detail-isolation.int-spec.ts`:
  tenant A runs a workflow with a private token in its input, tenant B requests the execution by id.
  On the starter code B gets `200` with A's input. `scripts/prove-finding.sh F-01`.
- **How it was fixed:** the controller passes the authenticated tenant and the service looks the
  execution up by `id` and `tenantId`; another tenant's execution is indistinguishable from a missing
  one (same `404` body). All other data access paths were audited: workflows were already scoped by
  tenant, webhooks resolve the tenant from the workflow. Row level security added in the same phase
  enforces the rule in the database as well, so a forgotten filter can no longer leak data.
- **Alternatives considered:** answering `403` for foreign executions (confirms that the id exists);
  checking ownership after loading the row (works, but the unscoped query is still one refactoring away
  from leaking again); relying on row level security alone (defence in depth needs both layers).

### F-02 · Tenant isolation unit test cannot fail · Tests that pass regardless of behaviour · Medium

- **What:** `apps/api/test/executions.service.spec.ts:8,23`. The test "does not list executions that
  belong to another tenant" replaces the repository with `find: jest.fn().mockResolvedValue([])` and
  asserts that the result is `[]`. Whatever `ExecutionsService.list()` asks the database for, the mock
  answers with an empty array, so the test cannot fail. It also never touches `get()`, which is where the
  real cross-tenant leak is (F-01).
- **Why it is dangerous:** it gives false confidence in the most sensitive property of a multi-tenant
  platform. A change that drops the tenant filter from the execution list ships with a green CI.
- **How to reproduce:** `scripts/mutation/F-02.sh` removes the tenant filter from `list()` and runs the
  whole API test suite against that mutant. On the starter suite the mutant survives: all tests pass and
  the script exits with 1. `scripts/prove-finding.sh F-02` runs the check on both commits.
- **How it was fixed:** the mocked test was removed and replaced by
  `apps/api/test/integration/findings/F-02-execution-list-isolation.int-spec.ts`: two tenants create real
  executions through the HTTP API against a real Postgres, and the test asserts that each tenant lists
  exactly its own executions and never one of the other tenant. Both assertions kill the mutant.
- **Alternatives considered:** keeping the unit test and asserting the `where` clause passed to the mock
  (still coupled to the TypeORM call shape and says nothing about what the database returns); a
  mutation-testing tool such as Stryker for the whole codebase (much heavier than needed for one
  property). A targeted mutation script was chosen because it proves exactly the claim in the test name.
  Since row level security was added, the database also stops this mutant, so the script is meaningful
  on the commits of this finding, which is how `prove-finding.sh` runs it.

### F-03 · Concurrent workers execute the same job several times · Queue correctness with several workers · Critical

- **What:** `apps/api/src/engine/job-queue.service.ts:17-34`. `claimNext` first selects the oldest
  queued job and then updates it in a separate statement, without a row lock and without re-checking
  `status = 'queued'` in the `UPDATE`. Every worker slot that polls between the two statements gets
  the same job and runs it.
- **Why it is dangerous:** side effects happen several times: the same HTTP call (a payment, an email,
  an order) is sent two, three or four times, step results are recorded several times and `attempts`
  is inflated. With the default compose setup (2 workers × 4 slots) a smoke run executed every step 8
  times.
- **How to reproduce:** `apps/api/test/integration/findings/F-03-exactly-once-claim.int-spec.ts`
  (the starter's `it.todo('claims each job exactly once when several workers poll concurrently')`):
  4 workers × 4 slots process 60 jobs whose single step calls a recording HTTP receiver. On the starter
  code the receiver saw 197 calls for 60 jobs. `scripts/prove-finding.sh F-03`.
- **How it was fixed:** claiming is one atomic statement in the `claim_job` function
  (`apps/api/src/migrations/1794308377302-atomic-job-claim.ts`): `UPDATE jobs ... FROM (SELECT id ...
  ORDER BY "runAt" LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`. A row locked by another claimer is
  skipped instead of waited for or taken twice. The function is `SECURITY DEFINER` because claiming
  is cross-tenant; it returns only the claimed job.
- **Alternatives considered:** `SELECT ... FOR UPDATE` without `SKIP LOCKED` (correct, but all
  workers queue behind the same row); an optimistic `UPDATE ... WHERE id = $1 AND status = 'queued'`
  with retries (correct, but under contention most claims lose and retry); advisory locks per job
  (state lives outside the table and is lost silently when a session ends); `LISTEN/NOTIFY` as the
  queue (notifications are not durable). See the queue design notes for the full comparison.

### F-04 · Jobs of a crashed worker are never recovered · Worker crash behaviour · Critical

- **What:** a claimed job gets `status = 'running'` and a 60 second `lockedUntil`
  (`apps/api/src/engine/job-queue.service.ts:6`), but nothing ever looks at `lockedUntil`: claiming
  only considers `status = 'queued'` (`:19`), there is no reaper and no heartbeat, and
  `apps/api/src/engine/job-runner.service.ts:52-92` never renews the lease. Writes at the end of a job
  are not tied to the lease either.
- **Why it is dangerous:** when a worker process dies (OOM, deploy, `SIGKILL`, node failure) every job
  it held stays `running` forever and its execution never finishes. Adding a naive reaper alone would
  be worse: a step that runs longer than the lease (a `delay`, a slow HTTP call) would be reclaimed
  while still running and executed twice, and the first worker would still be able to mark it done.
- **How to reproduce:** `apps/api/test/integration/findings/F-04-lease-recovery.int-spec.ts`
  (the starter's `it.todo('re-queues a job whose worker died while holding the lease')`) seeds jobs
  held by a worker that no longer exists, with an expired lease. On the starter code they stay
  `running` forever. `scripts/prove-finding.sh F-04`.
- **How it was fixed:**
  - reaper: every worker runs `reap_expired_jobs()` every `WORKER_REAPER_INTERVAL_MS`; expired jobs go
    back to `queued`, or to the new `dead` state when they already used all attempts (a job that kills
    its worker every time cannot loop forever), and the execution of a dead job is marked `failed`;
  - heartbeat: while a job runs, its worker extends `lockedUntil` every third of
    `WORKER_LEASE_SECONDS`; if the extension fails the lease is gone, the running step is aborted
    through an `AbortSignal` and its result is discarded;
  - fencing: extending, completing and failing a job only succeed for the same `lockedBy` and
    `attempts` that claimed it, and completion updates the job and the execution in one transaction.
  - Tests: `apps/api/test/integration/queue/lease.int-spec.ts` (a step longer than the lease is not
    taken over; a worker whose job was taken over cannot complete it).
- **Alternatives considered:** reclaiming expired jobs inside `claim_job` instead of a separate reaper
  (fewer moving parts, but dead jobs would need a second code path anyway and the reaper is easier to
  observe); session-level advisory locks as the ownership marker (released automatically when the
  connection dies, but a worker holds a connection per job for the whole step and ownership is
  invisible in the table); a very long lease without heartbeat (slow recovery and still unsafe for
  long steps).

### F-05 · A stopping worker abandons its current job · Worker crash behaviour · High

- **What:** `apps/api/src/engine/job-runner.service.ts:32-34`. On `SIGTERM` the worker only sets
  `running = false`. Nest then closes the TypeORM connection in the same shutdown sequence and exits,
  while the job that was being processed is still in the middle of a step: it can neither record its
  result nor give the job back.
- **Why it is dangerous:** every deploy, scale-down or `docker stop` leaves the jobs that were running
  at that moment stuck in `running` (permanently before F-04, for a whole lease after it), executions
  hang, and a job that had almost finished is redone later from scratch.
- **How to reproduce:** `apps/api/test/integration/findings/F-05-graceful-shutdown.int-spec.ts` runs a
  real worker process, sends `SIGTERM` in the middle of a step that finishes in 1.5 s and in the middle
  of a step that never finishes. On the starter code both jobs stay `running`.
  `scripts/prove-finding.sh F-05`.
- **How it was fixed:** `JobRunnerService.beforeApplicationShutdown` (runs before Nest closes the
  database connection) stops claiming and the reaper, waits up to `WORKER_SHUTDOWN_GRACE_MS` (25 s by
  default; compose gives the container 30 s before `SIGKILL`) for the running jobs, then aborts the
  remaining ones through their `AbortSignal` and releases them: back to `queued`, lease cleared,
  execution back to `pending`, and the attempt is not counted because the job did nothing wrong.
  Release is fenced like completion, and a job claimed while shutdown already started is released at
  once.
- **Alternatives considered:** exiting immediately and relying on lease expiry (correct after F-04, but
  every deploy delays affected executions by a full lease and costs an attempt); waiting without a
  limit (a hanging step would block the deploy until the orchestrator kills the process anyway);
  counting the interrupted attempt (a job could go `dead` purely because of frequent deploys).

### F-06 · A job whose workflow was deleted hangs forever · Queue poison jobs · High

- **What:** `apps/api/src/engine/job-runner.service.ts:53-54` loads the execution and the workflow with
  `findOneOrFail` before the `try` block that handles job failures. `DELETE /workflows/:id`
  (`apps/api/src/workflows/workflows.service.ts:55-58`) removes a workflow even when executions of it
  are still queued.
- **Why it is dangerous:** deleting a workflow right after starting it is a normal user action, but the
  worker loop catches the exception as a generic "loop error": the job is neither failed nor retried,
  it stays `running`, and the execution stays `pending` forever. After F-04 the job would only be
  reclaimed and crash again until it went `dead`, burning attempts and worker time without any useful
  error for the user.
- **How to reproduce:** `apps/api/test/integration/findings/F-06-poison-job.int-spec.ts` runs a workflow
  through the API, deletes it, starts a worker and expects a failed execution that mentions the
  workflow. On the starter code the execution stays `pending` and the job `running`.
  `scripts/prove-finding.sh F-06`.
- **How it was fixed:** the whole processing, including loading the execution and the workflow, is
  inside the failure handling. A missing execution or workflow is a non-retryable error with a clear
  message, so the job is failed once and the execution is marked `failed` with that message; any other
  unexpected error (for example a database outage) is treated as retryable.
- **Alternatives considered:** forbidding deletion while executions are pending (surprising for users
  and still leaves the worker fragile against any other missing row); a foreign key with
  `ON DELETE CASCADE` (silently deletes execution history). Executions will work from a snapshot of the
  workflow version taken at start (durable execution phase), so deleting a workflow will no longer
  affect executions that already started.

### F-18 · A retry repeats steps that already succeeded (includes F-21) · Execution properties · Critical

- **What:** `apps/api/src/engine/job-runner.service.ts:60-73` runs the workflow from step 0 on every
  attempt and inserts a new `step_runs` row each time; nothing reads earlier results back. The step
  bookkeeping is also not atomic or owned (finding F-21 of the audit): a step row is created, the step
  runs, and the row is updated in separate statements that any worker may write.
- **Why it is dangerous:** one failing step at the end of a workflow repeats every side effect before
  it on each retry: a payment step followed by a flaky notification charges the customer once per
  retry. `step_runs` fills with duplicates and orphaned `running` rows, so the history does not say
  which attempt produced the result.
- **How to reproduce:** `apps/api/test/integration/findings/F-18-resume-from-checkpoint.int-spec.ts`
  runs `charge (POST) → notify (fails once) → log`. On the starter code the charge endpoint is called
  twice and five step records exist for three steps. `scripts/prove-finding.sh F-18`.
- **How it was fixed:**
  - a step has exactly one checkpoint row: unique `(executionId, stepIndex)`, `attempts` counter,
    `finishedAt` (the migration merges existing duplicates, keeping the successful or latest row);
  - on every attempt the worker rebuilds `ctx.steps` from the stored outputs of succeeded steps and
    starts at the first step without a successful checkpoint; a finished step is never recomputed;
  - starting a step, recording its result and recording its failure each run in one transaction that
    first locks the job row and checks `lockedBy`/`attempts` (fencing), so a worker that lost its lease
    cannot overwrite the checkpoints of the new owner;
  - while a job waits for a retry its execution is `pending` with the last error instead of `running`.
  - Tests: `apps/api/test/integration/execution/checkpoints.int-spec.ts`.
- **Alternatives considered:** an append-only log of step attempts (full history, but every reader has
  to fold it to find the current state; the attempt count on the checkpoint is enough here); caching
  results in the job row (one big JSON rewritten per step, no per-step status); event sourcing as in
  Temporal (out of scope by the task).

### F-19 · A running execution picks up edits of its workflow · Execution properties · High

- **What:** `apps/api/src/workflows/workflows.service.ts:45-48` increments `version` when the steps
  change but keeps only the latest steps; executions do not record a version, and every attempt of a
  job loads the *current* workflow (`apps/api/src/engine/job-runner.service.ts:54,60`).
- **Why it is dangerous:** an execution started with one definition can continue with another: a
  retry after an edit runs steps the user never ran this input through, may call different endpoints
  and mixes outputs of two versions in `ctx.steps`. Nobody can tell afterwards which definition an
  execution actually used.
- **How to reproduce:** `apps/api/test/integration/findings/F-19-workflow-version-snapshot.int-spec.ts`:
  version 1 fails on its second step, the steps are edited while the job waits for its retry, then the
  retry runs. On the starter code the retry calls the endpoints of version 2. `scripts/prove-finding.sh F-19`.
- **How it was fixed:** every create and every change of the steps writes an immutable row to
  `workflow_versions` in the same transaction (the workflow row is locked, so concurrent edits get
  distinct versions); enqueueing records `executions.workflowVersion` under a share lock on the workflow;
  the worker reads the steps only from that snapshot. Deleting a workflow still cancels its unfinished
  executions on purpose: deletion is an explicit user action, an edit is not. Tests:
  `apps/api/test/integration/execution/workflow-versions.int-spec.ts`.
- **Alternatives considered:** copying the steps into every execution (simple, but duplicates the
  definition per run and loses the history of versions); refusing to edit a workflow with unfinished
  executions (blocks users for as long as a delay step lasts); letting deletion run started executions
  to the end (possible with snapshots, but surprising for a user who deletes a workflow to stop it).

### F-20 · A delay holds a worker slot and restarts after a crash · Execution properties · High

- **What:** `apps/api/src/engine/step-executor.ts:20-22` implements `delay` as an in-memory
  `setTimeout` inside the job, for up to an hour.
- **Why it is dangerous:** every waiting execution occupies a worker slot, so a handful of long delays
  stalls the queue for all tenants; the lease (60 s) is far shorter than the delay, so the job looks
  abandoned; a restart or crash loses the timer, and the delay starts again from zero together with
  every step before it.
- **How to reproduce:** `apps/api/test/integration/findings/F-20-durable-delay.int-spec.ts`: a worker
  with one slot must run another execution while the first one waits; the job must be released with a
  stored wake-up time; a worker killed with `SIGKILL` in the middle of a 3 s delay must not restart it.
  On the starter code the second execution waits, nothing is stored, and after the crash the next
  step runs 5.2 s after the previous one. `scripts/prove-finding.sh F-20`.
- **How it was fixed:** a delay is a durable timer. Starting it writes, in one fenced transaction, a
  `waiting` checkpoint with `wakeAt = now() + ms`, sets the execution to `waiting` and puts the job back
  in the queue with `runAt = wakeAt` without counting an attempt; the worker slot is free immediately.
  When the job is claimed again the step completes only if `wakeAt` has passed according to the
  database clock; a job picked up early (for example after a shutdown release) goes back to sleep until
  the same `wakeAt`. Tests: `apps/api/test/integration/execution/durable-timers.int-spec.ts`.
- **Alternatives considered:** a separate `timers` table polled by a scheduler (one more moving part;
  the queue's `runAt` already is a durable timer); keeping short delays in memory below a threshold
  (two behaviours for one step type and still lost on crash); `pg_sleep` in the database (holds a
  connection instead of a slot).

### F-23 · Input is not validated at the API boundary · Validation and error handling · Medium

- **What:** `apps/api/src/workflows/workflows.service.ts:7-13` declares the request body as a
  TypeScript `interface`, so the global `ValidationPipe` has nothing to validate; `create`
  (`:29-36`) stores `name`, `cron`, `timezone` and `enabled` as received. Steps are checked only for
  presence of their main field (`apps/api/src/workflows/definition.ts:23-25`).
  `apps/api/src/executions/executions.controller.ts:28` turns `?limit=` into `Number(limit)`, and
  `:20` accepts any JSON value as the execution input.
- **Why it is dangerous:** a missing name or `?limit=abc` produces a `500` from the database layer
  instead of a `400`; invalid cron expressions and time zones are stored and then fail silently in the
  scheduler on every tick; a six-field cron such as `* * * * * *` schedules a run every second, which
  lets one tenant flood the shared queue; unbounded expressions, messages, headers and bodies are
  stored and later executed by workers; header values with line breaks are passed to outgoing requests.
- **How to reproduce:** `apps/api/test/integration/findings/F-23-input-validation.int-spec.ts` sends
  24 invalid requests (missing or oversized fields, bad cron, sub-minute cron, unknown time zone,
  unsupported HTTP method, non-string headers or body, bad `limit`, array input). On the starter code
  23 of them are accepted or fail with `500`. `scripts/prove-finding.sh F-23`.
- **How it was fixed:**
  - `CreateWorkflowDto` / `UpdateWorkflowDto` (`apps/api/src/workflows/workflow.dto.ts`) with
    `class-validator` rules for name (1..200), steps, cron, timezone and enabled;
  - `validateSchedule` (`apps/api/src/workflows/schedule.ts`): 5 or 6 fields, parseable by
    `cron-parser`, never more often than once per minute (checked on the next ten occurrences in the
    workflow's time zone), valid IANA time zone; applied on create and on every update;
  - `validateSteps` (`apps/api/src/workflows/definition.ts`) now limits every field: URL length, HTTP
    method allow-list, header names, single-line string values, forbidden hop-by-hop headers, body,
    expression and message size;
  - `ListExecutionsQuery` requires an integer `limit` in 1..200, and `JsonObjectPipe` requires the
    execution input to be a JSON object.
  - Unit tests: `test/workflow-definition-limits.spec.ts`, `test/schedule-validation.spec.ts`.
- **Alternatives considered:** clamping invalid values silently (hides client bugs and still lets
  nonsense in); validating the whole workflow with a JSON schema library (one more dependency, while
  cross-field rules such as "cron frequency in this time zone" still need code); allowing sub-minute
  schedules for selected tenants (belongs to per-tenant limits, not to input validation).

### F-25 · API runs as a database superuser and accepts a placeholder admin token · Security / configuration · High

- **What:** `docker-compose.yml:4-7,17,25` and `apps/api/.env.example:2-3`. The API and the workers
  connect with the Postgres superuser that also owns the database, `synchronize: true` lets that
  connection rewrite the schema at start (`apps/api/src/app.module.ts:22`), and `ADMIN_TOKEN` is read
  straight from the environment (`apps/api/src/tenants/tenants.controller.ts:28`) with the placeholder
  `change-me-admin` accepted in any environment.
- **Why it is dangerous:** a superuser ignores row level security, so tenant isolation in the database
  cannot work at all; any SQL injection or bug in the application gets full control of the cluster;
  every instance alters the schema on start. A deployment that forgets to override `ADMIN_TOKEN` lets
  anyone who knows the public placeholder create tenants.
- **How to reproduce:** `apps/api/test/integration/findings/F-25-least-privilege.int-spec.ts` checks the
  role the running API uses (`rolsuper`, `rolbypassrls`, `rolcreatedb`, `rolcreaterole` must all be
  false), tries `CREATE TABLE` through the application connection, and starts the real API process in
  production with `ADMIN_TOKEN=change-me-admin`. On the starter code the role is a superuser, the table
  is created and the API starts. `scripts/prove-finding.sh F-25`.
- **How it was fixed:**
  - roles: `docker/postgres/provision.sql` creates `flowforge_owner` (owns the schema, runs
    migrations) and `flowforge_app` (DML only, no `BYPASSRLS`); the API and workers use
    `flowforge_app` (`apps/api/.env.example`);
  - schema: `synchronize` replaced by migrations (`apps/api/src/migrations`, baseline identical to the
    starter schema) applied by the one-shot `migrate` service under an advisory lock
    (`apps/api/src/db/run-migrations.ts`); API and workers start only after it succeeds;
  - configuration: `apps/api/src/config/config.ts` validates every setting per process on start and
    exits with a readable list of problems; in production `ADMIN_TOKEN` must be at least 32 random
    characters. Services receive configuration through injection instead of reading `process.env`.
  - tests: `test/config.spec.ts`, `test/integration/db/migrations.int-spec.ts` (schema equals entity
    metadata, tables are owned by the migration role, concurrent migrators apply each migration once).
- **Alternatives considered:** keeping `synchronize` and only switching the role (the application role
  would then need DDL rights, which defeats the purpose); running migrations on API start
  (every replica races to alter the schema and the API role needs DDL); a separate config library
  such as `@nestjs/config` with Joi (an extra dependency for seven variables; the custom loader keeps
  per-process rules and secret-free error messages explicit). Running containers as a non-root user
  and slimming the API image are left for the hardening phase.

## Changes to existing tests

| File | Change | Reason |
|---|---|---|
| `apps/api/test/executions.service.spec.ts` | removed | F-02: the test could not fail; replaced by a real integration test |
| `apps/api/test/job-queue.spec.ts` | removed `it.todo('claims each job exactly once when several workers poll concurrently')` | implemented as `test/integration/findings/F-03-exactly-once-claim.int-spec.ts` |
| `apps/api/test/job-queue.spec.ts` | removed `it.todo('re-queues a job whose worker died while holding the lease')` | implemented as `test/integration/findings/F-04-lease-recovery.int-spec.ts` |

All other starter tests are unchanged.
