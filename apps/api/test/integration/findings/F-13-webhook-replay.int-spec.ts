import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { Execution } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { createWebhookTarget, signWebhook, WebhookDelivery, WebhookTarget } from '../../support/webhooks';

describe('F-13 a webhook delivery is accepted once and only while it is fresh', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let target: WebhookTarget;
  const now = () => Math.floor(Date.now() / 1000);

  const deliver = (body: string, delivery: WebhookDelivery) =>
    request(app.getHttpServer())
      .post(`/hooks/${target.workflowId}`)
      .set('content-type', 'application/json')
      .set(signWebhook(target.webhookSecret, body, delivery))
      .send(body);

  const executionsWith = async (event: string) =>
    (await ctx.ds.getRepository(Execution).findBy({ workflowId: target.workflowId })).filter((e) => e.input.event === event);

  beforeAll(async () => {
    app = await createTestApp();
    target = await createWebhookTarget(app, 'replay');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('does not start a second execution when the same delivery is replayed', async () => {
    const body = '{"event":"replayed"}';
    const delivery = { id: `msg_${randomUUID()}`, timestamp: now() };

    const first = await deliver(body, delivery).expect(202);
    const second = await deliver(body, delivery);

    expect(second.status).toBe(202);
    expect(second.body.executionId).toBe(first.body.executionId);
    expect(await executionsWith('replayed')).toHaveLength(1);
  });

  it('treats a retry of the same event with a fresh timestamp as the same delivery', async () => {
    const body = '{"event":"retried"}';
    const id = `msg_${randomUUID()}`;

    const first = await deliver(body, { id, timestamp: now() - 120 }).expect(202);
    const retry = await deliver(body, { id, timestamp: now() }).expect(202);

    expect(retry.body.executionId).toBe(first.body.executionId);
    expect(await executionsWith('retried')).toHaveLength(1);
  });

  it('starts exactly one execution when duplicates arrive at the same time', async () => {
    const body = '{"event":"concurrent"}';
    const delivery = { id: `msg_${randomUUID()}`, timestamp: now() };

    const responses = await Promise.all(Array.from({ length: 10 }, () => deliver(body, delivery)));

    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(202));
    expect(new Set(responses.map((r) => r.body.executionId)).size).toBe(1);
    expect(await executionsWith('concurrent')).toHaveLength(1);
  });

  it('starts separate executions for different events', async () => {
    const body = '{"event":"distinct"}';

    await deliver(body, { id: `msg_${randomUUID()}`, timestamp: now() }).expect(202);
    await deliver(body, { id: `msg_${randomUUID()}`, timestamp: now() }).expect(202);

    expect(await executionsWith('distinct')).toHaveLength(2);
  });

  it.each([
    ['older than the tolerance', -600],
    ['too far in the future', 600],
  ])('rejects a delivery timestamped %s', async (_case, offset) => {
    const body = `{"event":"stale-${offset}"}`;

    await deliver(body, { id: `msg_${randomUUID()}`, timestamp: now() + offset }).expect(401);

    expect(await executionsWith(`stale-${offset}`)).toHaveLength(0);
  });
});
