# FlowForge

A multi-tenant durable workflow platform: NestJS API and workers, Next.js frontend, Postgres as the
only queue and state store.

## Running

```bash
docker compose up --build
```

API: http://localhost:3000, frontend: http://localhost:3001. Configuration: `apps/api/.env.example`.

## Tests

```bash
cd apps/api && npm ci
npm run test:unit
npm run test:int
scripts/prove-finding.sh F-NN
```

Integration tests need Docker (Postgres 16 via Testcontainers). `prove-finding.sh` checks that the
reproduction of a finding fails before its fix and passes after it.

## Findings

| ID | Finding | Reproduction |
|---|---|---|
| F-01 | Any tenant can read any execution by id | `test/integration/findings/F-01-execution-detail-isolation.int-spec.ts` |
| F-02 | Tenant isolation unit test cannot fail | `test/integration/findings/F-02-execution-list-isolation.int-spec.ts`, `scripts/mutation/F-02.sh` |
| F-03 | Concurrent workers execute the same job several times | `test/integration/findings/F-03-exactly-once-claim.int-spec.ts` |
| F-04 | Jobs of a crashed worker are never recovered | `test/integration/findings/F-04-lease-recovery.int-spec.ts` |
| F-05 | A stopping worker abandons its current job | `test/integration/findings/F-05-graceful-shutdown.int-spec.ts` |
| F-06 | A job whose workflow was deleted hangs forever | `test/integration/findings/F-06-poison-job.int-spec.ts` |
| F-07 | Transform steps run arbitrary code on the host | `test/integration/findings/F-07-transform-sandbox.int-spec.ts` |
| F-08 | Http steps can reach internal addresses | `test/integration/findings/F-08-ssrf.int-spec.ts` |
| F-09 | Step results are read and stored without a size limit | `test/integration/findings/F-09-response-size-limits.int-spec.ts` |
| F-10 | Input values can rewrite the url of an http step | `test/integration/findings/F-10-url-template-injection.int-spec.ts` |
| F-18 | A retry repeats steps that already succeeded | `test/integration/findings/F-18-resume-from-checkpoint.int-spec.ts` |
| F-19 | A running execution picks up edits of its workflow | `test/integration/findings/F-19-workflow-version-snapshot.int-spec.ts` |
| F-20 | A delay holds a worker slot and restarts after a crash | `test/integration/findings/F-20-durable-delay.int-spec.ts` |
| F-23 | Input is not validated at the API boundary | `test/integration/findings/F-23-input-validation.int-spec.ts` |
| F-25 | API runs as a database superuser and accepts a placeholder admin token | `test/integration/findings/F-25-least-privilege.int-spec.ts` |
| F-26 | A NUL character makes data impossible to store | `test/integration/findings/F-26-nul-characters.int-spec.ts` |

## Changes to existing tests

| File | Change | Reason |
|---|---|---|
| `apps/api/test/executions.service.spec.ts` | removed | the test could not fail; replaced by F-02 |
| `apps/api/test/job-queue.spec.ts` | removed the exactly-once `it.todo` | implemented by F-03 |
| `apps/api/test/job-queue.spec.ts` | removed the lease recovery `it.todo` | implemented by F-04 |
