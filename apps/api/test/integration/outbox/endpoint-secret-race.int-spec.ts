import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WebhookSecret } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant } from '../../support/db';

describe('setting a notification endpoint from several requests at once', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('creates one outbound signing secret, not one per request', async () => {
    const tenant = await seedTenant(ctx.ds, 'endpoint-race');

    const responses = await Promise.all(
      Array.from({ length: 40 }, () =>
        request(app.getHttpServer()).put('/notifications/endpoint').set('x-api-key', tenant.apiKey).send({ url: 'https://example.com/hooks' }),
      ),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(40).fill(200));
    expect(responses.filter((r) => r.body.secret).length).toBe(1);
    expect(await ctx.ds.getRepository(WebhookSecret).countBy({ tenantId: tenant.tenant.id, purpose: 'outbound' })).toBe(1);
  });

  it('keeps at most three outbound secrets when endpoints are set while secrets are rotated', async () => {
    const tenant = await seedTenant(ctx.ds, 'endpoint-rotation-race');
    const server = app.getHttpServer();
    for (let round = 0; round < 5; round++) {
      await ctx.ds.getRepository(WebhookSecret).delete({ tenantId: tenant.tenant.id, purpose: 'outbound' });
      await Promise.all([
        ...Array.from({ length: 10 }, () => request(server).put('/notifications/endpoint').set('x-api-key', tenant.apiKey).send({ url: 'https://example.com/hooks' })),
        ...Array.from({ length: 10 }, () => request(server).post('/notifications/secrets').set('x-api-key', tenant.apiKey)),
      ]);

      expect(await ctx.ds.getRepository(WebhookSecret).countBy({ tenantId: tenant.tenant.id, purpose: 'outbound' })).toBeLessThanOrEqual(3);
    }
  });
});
