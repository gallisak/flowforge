# FlowForge — стартовий репозиторій

Мультитенантна платформа автоматизації: користувач описує workflow як послідовність кроків
(`http`, `transform`, `log`, `delay`), запускає його вручну, за webhook-ом або за cron-розкладом,
а воркери виконують кроки з черги в Postgres.

## Склад

- `apps/api` — NestJS: HTTP API (`main.ts`), планувальник cron (працює в API-процесі),
  окремий процес-воркер (`worker.ts`).
- `apps/frontend` — Next.js (App Router): ввід API-ключа, список workflow, сторінка виконання.
- `docker-compose.yml` — Postgres, API, два воркери, фронтенд.

## Запуск

```bash
docker-compose up --build
```

- API: http://localhost:3000, фронтенд: http://localhost:3001

Створити тенанта (токен — `ADMIN_TOKEN` з `apps/api/.env.example`):

```bash
curl -X POST localhost:3000/tenants -H 'x-admin-token: change-me-admin' \
  -H 'content-type: application/json' -d '{"name":"acme"}'
```

Відповідь містить `apiKey` (показується один раз) і `webhookSecret`. Далі всі запити —
із заголовком `x-api-key`.

## Основні ендпоінти

| Метод | Шлях | Опис |
|---|---|---|
| POST/GET/PATCH/DELETE | `/workflows[/:id]` | керування workflow |
| POST | `/workflows/:id/run` | запуск вручну (тіло — input) |
| GET | `/executions`, `/executions/:id` | виконання та їхні кроки |
| POST | `/hooks/:workflowId` | вхідний webhook, підпис у `x-signature` (HMAC-SHA256 hex) |

Приклад workflow:

```json
{
  "name": "demo",
  "steps": [
    { "id": "fetch", "type": "http", "url": "https://example.com/api?q={{ input.q }}" },
    { "id": "shape", "type": "transform", "expr": "ctx.steps.fetch.body" }
  ]
}
```

## Тести

```bash
cd apps/api && npm install && npm test
```

Не всі тести однаково надійні, а частина поведінки ще не покрита.

## Що відомо про стан коду

- Базовий функціонал працює, але система ще не готова до продакшену.
- `synchronize: true` у TypeORM залишено для простоти старту; міграцій немає.
