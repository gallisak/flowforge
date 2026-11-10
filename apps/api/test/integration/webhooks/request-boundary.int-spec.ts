import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { createWebhookTarget, signWebhook, WebhookTarget } from '../../support/webhooks';

describe('webhook request boundary', () => {
  useIntegrationContext();
  let app: INestApplication;
  let target: WebhookTarget;

  const deliver = (body: string) =>
    request(app.getHttpServer())
      .post(`/hooks/${target.workflowId}`)
      .set('content-type', 'application/json')
      .set(signWebhook(target.webhookSecret, body))
      .send(body);

  beforeAll(async () => {
    app = await createTestApp();
    target = await createWebhookTarget(app, 'boundary');
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each([
    ['an empty body', ''],
    ['an array', '[1,2]'],
  ])('rejects %s as a client error', async (_case, body) => {
    const response = await deliver(body);

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Webhook body must be a JSON object');
  });

  it('rejects a bare JSON string as a client error', async () => {
    await deliver('"event"').expect(400);
  });

  it('rejects a body above the size limit', async () => {
    await deliver(JSON.stringify({ pad: 'a'.repeat(200_000) })).expect(413);
  });
});
