import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { createWebhookTarget, signWebhook, WebhookTarget } from '../../support/webhooks';

const SECRET = 'client-address-secret-for-integration-tests';

function from(address: string, secret = SECRET): Record<string, string> {
  return { 'x-client-address': address, 'x-client-address-secret': secret };
}

describe('failed authentication buckets', () => {
  useIntegrationContext();
  let app: INestApplication;
  let first: WebhookTarget;
  let third: WebhookTarget;
  const saved = { limit: process.env.AUTH_FAILURES_PER_MINUTE, secret: process.env.CLIENT_ADDRESS_SECRET };

  beforeAll(async () => {
    process.env.AUTH_FAILURES_PER_MINUTE = '3';
    process.env.CLIENT_ADDRESS_SECRET = SECRET;
    app = await createTestApp();
    first = await createWebhookTarget(app, 'bucket-first');
    third = await createWebhookTarget(app, 'bucket-third');
  });

  afterAll(async () => {
    await app?.close();
    for (const [name, value] of [
      ['AUTH_FAILURES_PER_MINUTE', saved.limit],
      ['CLIENT_ADDRESS_SECRET', saved.secret],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('are kept per client address that a trusted caller forwards', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 3; i++) {
      await request(server).get('/workflows').set(from('203.0.113.1')).set('x-api-key', `ff_wrong_${i}`).expect(401);
    }

    await request(server).get('/workflows').set(from('203.0.113.1')).set('x-api-key', 'ff_wrong_again').expect(429);
    await request(server).get('/workflows').set(from('203.0.113.2')).set('x-api-key', first.apiKey).expect(200);
  });

  it('ignore a forwarded client address without the shared secret', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 3; i++) {
      await request(server).get('/workflows').set(from(`198.51.100.${i}`, 'not-the-secret')).set('x-api-key', `ff_wrong_${i}`).expect(401);
    }

    await request(server).get('/workflows').set(from('198.51.100.9', 'not-the-secret')).set('x-api-key', 'ff_wrong_spoofed').expect(429);
    await request(server).get('/workflows').set('x-api-key', 'ff_wrong_direct').expect(429);
    await request(server).get('/workflows').set(from('198.51.100.9')).set('x-api-key', 'ff_wrong_forwarded').expect(401);
  });

  it('do not let failed webhooks for one workflow or failed API keys block another workflow', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 3; i++) {
      await request(server)
        .post(`/hooks/${first.workflowId}`)
        .set('content-type', 'application/json')
        .set(signWebhook('whsec_Zm9yZ2Vk', '{}'))
        .send('{}')
        .expect(401);
    }
    const blocked = await request(server)
      .post(`/hooks/${first.workflowId}`)
      .set('content-type', 'application/json')
      .set(signWebhook(first.webhookSecret, '{}'))
      .send('{}');

    const accepted = await request(server)
      .post(`/hooks/${third.workflowId}`)
      .set('content-type', 'application/json')
      .set(signWebhook(third.webhookSecret, '{}'))
      .send('{}');

    expect(blocked.status).toBe(429);
    expect(accepted.status).toBe(202);
  });

  it('limit failed admin tokens', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 3; i++) {
      await request(server).post('/tenants').set(from('192.0.2.7')).set('x-admin-token', `wrong-admin-token-${i}`).send({ name: 'nope' }).expect(403);
    }

    const blocked = await request(server).post('/tenants').set(from('192.0.2.7')).set('x-admin-token', 'wrong-admin-token-again').send({ name: 'nope' });
    const other = await request(server).post('/tenants').set(from('192.0.2.8')).set('x-admin-token', process.env.ADMIN_TOKEN ?? '').send({ name: 'allowed' });

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(other.status).toBe(201);
  });
});
