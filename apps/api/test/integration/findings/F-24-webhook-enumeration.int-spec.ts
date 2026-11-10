import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { createWebhookTarget, signWebhook, WebhookTarget } from '../../support/webhooks';

describe('F-24 a webhook does not reveal which workflows exist', () => {
  useIntegrationContext();
  let app: INestApplication;
  let target: WebhookTarget;
  let disabled: WebhookTarget;
  const body = '{"event":"probe"}';

  const deliver = (workflowId: string, headers: Record<string, string>) =>
    request(app.getHttpServer()).post(`/hooks/${workflowId}`).set('content-type', 'application/json').set(headers).send(body);

  beforeAll(async () => {
    app = await createTestApp();
    target = await createWebhookTarget(app, 'enumeration');
    disabled = await createWebhookTarget(app, 'enumeration-disabled');
    await request(app.getHttpServer())
      .patch(`/workflows/${disabled.workflowId}`)
      .set('x-api-key', disabled.apiKey)
      .send({ enabled: false })
      .expect(200);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('answers an unknown workflow, a disabled workflow and a bad signature identically', async () => {
    const badSignature = await deliver(target.workflowId, signWebhook('wrong-secret', body));
    const unknown = await deliver(randomUUID(), signWebhook('wrong-secret', body));
    const off = await deliver(disabled.workflowId, signWebhook(disabled.webhookSecret, body));

    expect(badSignature.status).toBe(401);
    expect([unknown.status, unknown.body]).toEqual([badSignature.status, badSignature.body]);
    expect([off.status, off.body]).toEqual([badSignature.status, badSignature.body]);
  });
});
