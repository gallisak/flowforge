import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Execution } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { createWebhookTarget, signWebhook, WebhookTarget } from '../../support/webhooks';

describe('a signed webhook delivery cannot be replayed against another workflow of the tenant', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let target: WebhookTarget;
  let otherWorkflowId: string;

  const deliver = (workflowId: string, body: string, headers: Record<string, string>) =>
    request(app.getHttpServer()).post(`/hooks/${workflowId}`).set('content-type', 'application/json').set(headers).send(body);

  beforeAll(async () => {
    app = await createTestApp();
    target = await createWebhookTarget(app, 'cross-workflow');
    const other = await request(app.getHttpServer())
      .post('/workflows')
      .set('x-api-key', target.apiKey)
      .send({ name: 'refunds', steps: [{ id: 'note', type: 'log', message: 'refund {{ input.event }}' }] })
      .expect(201);
    otherWorkflowId = other.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('refuses a captured delivery sent to a different workflow', async () => {
    const body = '{"event":"order-created"}';
    const headers = signWebhook(target.webhookSecret, body);

    await deliver(target.workflowId, body, headers).expect(202);
    const replay = await deliver(otherWorkflowId, body, headers);

    expect(replay.status).toBe(409);
    expect(await ctx.ds.getRepository(Execution).countBy({ workflowId: otherWorkflowId })).toBe(0);
  });

  it('still accepts a delivery with its own webhook-id for the other workflow', async () => {
    const body = '{"event":"refund-requested"}';

    await deliver(otherWorkflowId, body, signWebhook(target.webhookSecret, body)).expect(202);
  });
});
