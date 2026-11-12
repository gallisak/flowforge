import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TenantDb } from '../../../src/db/tenant-db.service';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { createWebhookTarget, signWebhook, WebhookTarget } from '../../support/webhooks';

describe('failed authentication attempts from one address', () => {
  useIntegrationContext();
  let app: INestApplication;
  let target: WebhookTarget;
  const saved = process.env.AUTH_FAILURES_PER_MINUTE;

  beforeAll(async () => {
    process.env.AUTH_FAILURES_PER_MINUTE = '3';
    app = await createTestApp();
    target = await createWebhookTarget(app, 'limited');
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
    if (saved === undefined) delete process.env.AUTH_FAILURES_PER_MINUTE;
    else process.env.AUTH_FAILURES_PER_MINUTE = saved;
  });

  it('are answered without touching the database once over the limit, while a key that worked recently still works', async () => {
    const server = app.getHttpServer();
    await request(server).get('/workflows').set('x-api-key', target.apiKey).expect(200);
    for (let i = 0; i < 3; i++) await request(server).get('/workflows').set('x-api-key', `ff_wrong_${i}`).expect(401);
    const authenticate = jest.spyOn(app.get(TenantDb), 'authenticate');

    const blocked = await request(server).get('/workflows').set('x-api-key', 'ff_wrong_again');
    await request(server).get('/workflows').set('x-api-key', target.apiKey).expect(200);

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it('are answered without touching the database once one webhook gets too many forged signatures', async () => {
    const server = app.getHttpServer();
    const forge = () =>
      request(server).post(`/hooks/${target.workflowId}`).set('content-type', 'application/json').set(signWebhook('whsec_Zm9yZ2Vk', '{}')).send('{}');
    for (let i = 0; i < 3; i++) await forge().expect(401);
    const resolve = jest.spyOn(app.get(TenantDb), 'resolveWebhookTenant');

    const forged = await forge();

    expect(forged.status).toBe(429);
    expect(resolve).not.toHaveBeenCalled();
  });
});
