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
