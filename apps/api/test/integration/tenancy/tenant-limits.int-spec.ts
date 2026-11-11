import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { Job } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { createWebhookTarget, signWebhook, WebhookTarget } from '../../support/webhooks';

describe('tenant limits', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;

  const server = () => app.getHttpServer();
  const admin = (tenantId: string, limits: Record<string, unknown>) =>
    request(server()).patch(`/tenants/${tenantId}/limits`).set('x-admin-token', process.env.ADMIN_TOKEN ?? '').send(limits);
  const tenantIdOf = async (target: WebhookTarget) =>
    (await ctx.ds.getRepository(Job).manager.query(`SELECT "tenantId" FROM workflows WHERE id = $1`, [target.workflowId]))[0].tenantId as string;
  const run = (target: WebhookTarget, input: Record<string, unknown> = {}) =>
    request(server()).post(`/workflows/${target.workflowId}/run`).set('x-api-key', target.apiKey).send(input);
  const hook = (target: WebhookTarget, body: string, id = `msg_${randomUUID()}`, secret = target.webhookSecret) =>
    request(server()).post(`/hooks/${target.workflowId}`).set('content-type', 'application/json').set(signWebhook(secret, body, { id })).send(body);

  const SETUP_REQUESTS = 1;

  async function awayFromMinuteBoundary(): Promise<void> {
    const intoMinute = Date.now() % 60_000;
    if (intoMinute > 50_000) await new Promise((resolve) => setTimeout(resolve, 60_500 - intoMinute));
  }

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('queue size', () => {
    it('refuses new executions once the tenant has its maximum of queued jobs', async () => {
      const target = await createWebhookTarget(app, 'queue-full');
      await admin(await tenantIdOf(target), { maxQueuedJobs: 3 }).expect(200);

      for (let i = 0; i < 3; i++) await run(target).expect(201);
      const refused = await run(target);

      expect(refused.status).toBe(429);
      expect(refused.headers['retry-after']).toBe('30');
      expect(refused.body.message).toBe('Queue limit of 3 jobs reached');
      expect(await ctx.ds.getRepository(Job).countBy({ tenantId: await tenantIdOf(target) })).toBe(3);
    });

    it('fills the queue up to the limit under concurrent requests and refuses afterwards', async () => {
      const target = await createWebhookTarget(app, 'queue-race');
      await admin(await tenantIdOf(target), { maxQueuedJobs: 5 }).expect(200);

      const statuses = (await Promise.all(Array.from({ length: 12 }, () => run(target)))).map((r) => r.status);

      expect(statuses.every((s) => s === 201 || s === 429)).toBe(true);
      expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(5);
      await run(target).expect(429);
    });

    it('still answers a repeated webhook delivery when the queue is full', async () => {
      const target = await createWebhookTarget(app, 'queue-webhook');
      await admin(await tenantIdOf(target), { maxQueuedJobs: 1 }).expect(200);
      const body = '{"event":"first"}';
      const id = `msg_${randomUUID()}`;

      const first = await hook(target, body, id).expect(202);
      await hook(target, '{"event":"second"}').expect(429);
      const repeated = await hook(target, body, id).expect(202);

      expect(repeated.body.executionId).toBe(first.body.executionId);
    });

    it('does not limit other tenants', async () => {
      const full = await createWebhookTarget(app, 'queue-full-neighbour');
      const other = await createWebhookTarget(app, 'queue-other');
      await admin(await tenantIdOf(full), { maxQueuedJobs: 1 }).expect(200);
      await run(full).expect(201);
      await run(full).expect(429);

      await run(other).expect(201);
    });
  });

  describe('request rate', () => {
    beforeEach(awayFromMinuteBoundary);

    it('answers 429 with rate limit headers after the per-minute limit', async () => {
      const target = await createWebhookTarget(app, 'rate-limited');
      await admin(await tenantIdOf(target), { rateLimitPerMinute: 5 }).expect(200);

      const remaining = [];
      for (let i = SETUP_REQUESTS; i < 5; i++) {
        const ok = await request(server()).get('/workflows').set('x-api-key', target.apiKey).expect(200);
        expect(ok.headers['x-ratelimit-limit']).toBe('5');
        remaining.push(ok.headers['x-ratelimit-remaining']);
      }
      const limited = await request(server()).get('/workflows').set('x-api-key', target.apiKey);

      expect(remaining).toEqual(['3', '2', '1', '0']);
      expect(limited.status).toBe(429);
      expect(limited.headers['x-ratelimit-remaining']).toBe('0');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
      expect(Number(limited.headers['x-ratelimit-reset']) * 1000).toBeGreaterThan(Date.now());
    });

    it('counts signed webhook deliveries against the same budget but not forged ones', async () => {
      const target = await createWebhookTarget(app, 'rate-webhooks');
      await admin(await tenantIdOf(target), { rateLimitPerMinute: SETUP_REQUESTS + 3 }).expect(200);

      for (let i = 0; i < 5; i++) await hook(target, '{"event":"forged"}', undefined, 'whsec_d3JvbmctZm9yZ2VkLXNlY3JldA==').expect(401);
      await hook(target, '{"event":"a"}').expect(202);
      await hook(target, '{"event":"b"}').expect(202);
      await request(server()).get('/workflows').set('x-api-key', target.apiKey).expect(200);

      await hook(target, '{"event":"c"}').expect(429);
      await request(server()).get('/workflows').set('x-api-key', target.apiKey).expect(429);
    });

    it('does not limit other tenants', async () => {
      const limited = await createWebhookTarget(app, 'rate-neighbour');
      const other = await createWebhookTarget(app, 'rate-other');
      await admin(await tenantIdOf(limited), { rateLimitPerMinute: SETUP_REQUESTS + 1 }).expect(200);
      await request(server()).get('/workflows').set('x-api-key', limited.apiKey).expect(200);
      await request(server()).get('/workflows').set('x-api-key', limited.apiKey).expect(429);

      await request(server()).get('/workflows').set('x-api-key', other.apiKey).expect(200);
    });

    it('rejects an unknown api key before counting anything', async () => {
      await request(server()).get('/workflows').set('x-api-key', 'ff_unknown').expect(401);
    });
  });

  describe('admin endpoint', () => {
    it('stores limits and resets them to the defaults with null', async () => {
      const target = await createWebhookTarget(app, 'admin-limits');
      const tenantId = await tenantIdOf(target);

      const set = await admin(tenantId, { maxConcurrentJobs: 2, maxQueuedJobs: 100, rateLimitPerMinute: 60 }).expect(200);
      expect(set.body).toEqual({ id: tenantId, maxConcurrentJobs: 2, maxQueuedJobs: 100, rateLimitPerMinute: 60 });

      const reset = await admin(tenantId, { maxQueuedJobs: null }).expect(200);
      expect(reset.body).toEqual({ id: tenantId, maxConcurrentJobs: 2, maxQueuedJobs: null, rateLimitPerMinute: 60 });
    });

    it.each([{ maxConcurrentJobs: 0 }, { maxQueuedJobs: 1.5 }, { rateLimitPerMinute: 'many' }, { maxConcurrentJobs: 10_001 }])(
      'rejects %o',
      async (limits) => {
        const target = await createWebhookTarget(app, `admin-invalid-${randomUUID()}`);
        await admin(await tenantIdOf(target), limits).expect(400);
      },
    );

    it('answers 404 for an unknown tenant', async () => {
      await admin(randomUUID(), { maxQueuedJobs: 5 }).expect(404);
    });

    it('requires the admin token', async () => {
      const target = await createWebhookTarget(app, 'admin-token');
      await request(server()).patch(`/tenants/${await tenantIdOf(target)}/limits`).send({ maxQueuedJobs: 5 }).expect(403);
      await request(server())
        .patch(`/tenants/${await tenantIdOf(target)}/limits`)
        .set('x-api-key', target.apiKey)
        .send({ maxQueuedJobs: 5 })
        .expect(403);
    });
  });
});
