# FlowForge — starter repository

A multi-tenant automation platform: a user describes a workflow as a sequence of steps
(`http`, `transform`, `log`, `delay`), runs it manually, via a webhook or on a cron schedule,
and workers execute the steps from a queue in Postgres.

## Layout

- `apps/api` — NestJS: HTTP API (`main.ts`), cron scheduler (runs inside the API process),
  separate worker process (`worker.ts`).
- `apps/frontend` — Next.js (App Router): API key input, workflow list, execution page.
- `docker-compose.yml` — Postgres, API, two workers, frontend.

## Running

```bash
docker-compose up --build
```

- API: http://localhost:3000, frontend: http://localhost:3001

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

## Tests

```bash
cd apps/api && npm install && npm test
```

Not all tests are equally reliable, and part of the behaviour is not covered yet.

## Known state of the code

- Basic functionality works, but the system is not production-ready yet.
- `synchronize: true` in TypeORM is kept for a simpler start; there are no migrations.

## Findings

Every finding is reproduced by an automated test or script that fails on the code before the fix
and passes after it. Each finding is two consecutive commits: the first adds the reproduction
(red), the second fixes the code (green). `scripts/prove-finding.sh F-NN` checks both states
automatically in throwaway git worktrees. Line references point to the `initial commit`.

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

## Changes to existing tests

| File | Change | Reason |
|---|---|---|
| `apps/api/test/executions.service.spec.ts` | removed | F-02: the test could not fail; replaced by a real integration test |

All other starter tests are unchanged. The two `it.todo` entries in `test/job-queue.spec.ts` are
implemented as separate integration tests together with the corresponding fixes.
