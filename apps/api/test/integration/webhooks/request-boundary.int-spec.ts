import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { gzipSync } from 'zlib';
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

  it('accepts and deduplicates a webhook-id of the longest allowed length', async () => {
    const body = JSON.stringify({ order: 'long-id' });
    const id = `msg_${'x'.repeat(252)}`;
    const send = () =>
      request(app.getHttpServer())
        .post(`/hooks/${target.workflowId}`)
        .set('content-type', 'application/json')
        .set(signWebhook(target.webhookSecret, body, { id }))
        .send(body);

    const first = await send().expect(202);
    const again = await send().expect(202);

    expect(again.body.executionId).toBe(first.body.executionId);
  });

  it('refuses a compressed body, so that the signature is always checked over the bytes as they arrived', async () => {
    const body = '{"event":"compressed"}';
    const response = await request(app.getHttpServer())
      .post(`/hooks/${target.workflowId}`)
      .set('content-type', 'application/json')
      .set('content-encoding', 'gzip')
      .set(signWebhook(target.webhookSecret, body))
      .send(gzipSync(body));

    expect(response.status).toBe(415);
  });

  it('rejects a body above the size limit', async () => {
    await deliver(JSON.stringify({ pad: 'a'.repeat(200_000) })).expect(413);
  });
});
