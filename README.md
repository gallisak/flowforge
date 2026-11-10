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
| `ADMIN_TOKEN` | api | — | required; at least 8 characters, in production at least 32 random characters |
| `WORKER_CONCURRENCY` | worker | `4` | integer 1..64 |
| `SCHEDULER_TICK_MS` | api | `30000` | integer 1000..3600000 |

## Database

The schema is managed by TypeORM migrations in `apps/api/src/migrations`; `synchronize` is off.
`npm run migrate` (or the `migrate` compose service) applies pending migrations under a Postgres
advisory lock, so several migrators started at once apply each migration exactly once.
`npm run migration:generate -- src/migrations/<Name>` generates a migration from entity changes.

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

All other starter tests are unchanged. The two `it.todo` entries in `test/job-queue.spec.ts` are
implemented as separate integration tests together with the corresponding fixes.
