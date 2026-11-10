import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Execution } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { createWebhookTarget, signWebhook, WebhookTarget } from '../../support/webhooks';

describe('F-11 a webhook signature covers the body exactly as it was sent', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let target: WebhookTarget;

  const deliver = (body: string, headers: Record<string, string>, contentType = 'application/json') =>
    request(app.getHttpServer()).post(`/hooks/${target.workflowId}`).set('content-type', contentType).set(headers).send(body);

  beforeAll(async () => {
    app = await createTestApp();
    target = await createWebhookTarget(app, 'raw-body');
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each([
    ['whitespace and key order', '{ "event": "order.paid",\n  "amount": 10 }'],
    ['a number written with a fraction', '{"event":"order.paid","amount":10.0}'],
    ['escaped unicode characters', '{"event":"caf\\u00e9"}'],
  ])('accepts a correctly signed body with %s', async (_case, body) => {
    const response = await deliver(body, signWebhook(target.webhookSecret, body));

    expect(response.status).toBe(202);
    const execution = await ctx.ds.getRepository(Execution).findOneByOrFail({ id: response.body.executionId });
    expect(execution.input).toEqual(JSON.parse(body));
  });

  it('rejects a body changed after signing', async () => {
    const signed = '{"event":"order.paid","amount":10}';
    const response = await deliver('{"event":"order.paid","amount":10000}', signWebhook(target.webhookSecret, signed));

    expect(response.status).toBe(401);
  });

  it('refuses a body that is not JSON instead of verifying a different payload', async () => {
    const body = 'event=order.paid';
    const response = await deliver(body, signWebhook(target.webhookSecret, body), 'application/x-www-form-urlencoded');

    expect(response.status).toBe(415);
  });
});
