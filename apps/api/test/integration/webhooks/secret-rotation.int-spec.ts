import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { WebhookSecret } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { createWebhookTarget, signWebhook, WebhookTarget } from '../../support/webhooks';

describe('webhook secret rotation', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let target: WebhookTarget;
  let other: WebhookTarget;
  const body = '{"event":"rotation"}';

  const server = () => app.getHttpServer();
  const deliver = (secret: string) =>
    request(server()).post(`/hooks/${target.workflowId}`).set('content-type', 'application/json').set(signWebhook(secret, body)).send(body);
  const rotate = (apiKey = target.apiKey) => request(server()).post('/webhook-secrets').set('x-api-key', apiKey).expect(201);
  const list = (apiKey = target.apiKey) => request(server()).get('/webhook-secrets').set('x-api-key', apiKey).expect(200);

  beforeAll(async () => {
    app = await createTestApp();
    other = await createWebhookTarget(app, 'rotation-other');
  });

  beforeEach(async () => {
    target = await createWebhookTarget(app, `rotation-${Date.now()}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('accepts both the previous and the new secret during the grace period', async () => {
    const rotated = await rotate();

    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(target.webhookSecret);
    await deliver(target.webhookSecret).expect(202);
    await deliver(rotated.body.secret).expect(202);
  });

  it('stops accepting the previous secret once its grace period is over', async () => {
    const rotated = await rotate();
    await ctx.ds.getRepository(WebhookSecret).update({ secret: target.webhookSecret }, { expiresAt: new Date(Date.now() - 1_000) });

    await deliver(target.webhookSecret).expect(401);
    await deliver(rotated.body.secret).expect(202);
  });

  it('gives the previous secret an expiry and the new one none', async () => {
    const before = Date.now();
    const rotated = await rotate();
    const secrets = (await list()).body as Array<{ id: string; expiresAt: string | null }>;

    const previous = secrets.find((s) => s.id !== rotated.body.id);
    expect(secrets.find((s) => s.id === rotated.body.id)?.expiresAt).toBeNull();
    expect(new Date(previous?.expiresAt ?? 0).getTime()).toBeGreaterThan(before + 23 * 3_600_000);
  });

  it('revokes a secret immediately', async () => {
    const rotated = await rotate();
    const previous = ((await list()).body as Array<{ id: string }>).find((s) => s.id !== rotated.body.id);

    await request(server()).delete(`/webhook-secrets/${previous?.id}`).set('x-api-key', target.apiKey).expect(204);

    await deliver(target.webhookSecret).expect(401);
    await deliver(rotated.body.secret).expect(202);
  });

  it('never returns secret values when listing', async () => {
    await rotate();
    const listed = await list();

    expect(JSON.stringify(listed.body)).not.toContain('whsec_');
    expect(listed.body).toHaveLength(2);
    for (const item of listed.body) expect(Object.keys(item).sort()).toEqual(['createdAt', 'expiresAt', 'id']);
  });

  it('keeps the number of stored secrets bounded by removing expired ones', async () => {
    await rotate();
    await ctx.ds.getRepository(WebhookSecret).update({ secret: target.webhookSecret }, { expiresAt: new Date(Date.now() - 1_000) });
    await rotate();

    const tenantSecrets = await ctx.ds.getRepository(WebhookSecret).find({ where: { secret: target.webhookSecret } });
    expect(tenantSecrets).toHaveLength(0);
  });

  it('keeps at most three secrets active, so a burst of rotations cannot slow down signature checks', async () => {
    const rotated: string[] = [];
    for (let i = 0; i < 6; i++) rotated.push((await rotate()).body.secret);

    expect((await list()).body).toHaveLength(3);
    await deliver(target.webhookSecret).expect(401);
    await deliver(rotated[2]).expect(401);
    await deliver(rotated[3]).expect(202);
    await deliver(rotated[5]).expect(202);
  });

  it('keeps at most three outbound secrets, so the signature header of a notification stays small', async () => {
    await request(server()).put('/notifications/endpoint').set('x-api-key', target.apiKey).send({ url: 'https://example.com/hook' }).expect(200);
    for (let i = 0; i < 6; i++) await request(server()).post('/notifications/secrets').set('x-api-key', target.apiKey).expect(201);

    const outbound = await request(server()).get('/notifications/secrets').set('x-api-key', target.apiKey).expect(200);
    expect(outbound.body).toHaveLength(3);
  });

  it('does not let another tenant see or revoke the secrets', async () => {
    const mine = ((await list()).body as Array<{ id: string }>)[0];

    expect(((await list(other.apiKey)).body as Array<{ id: string }>).map((s) => s.id)).not.toContain(mine.id);
    await request(server()).delete(`/webhook-secrets/${mine.id}`).set('x-api-key', other.apiKey).expect(404);
    await deliver(target.webhookSecret).expect(202);
  });

  it('requires an api key', async () => {
    await request(server()).get('/webhook-secrets').expect(401);
    await request(server()).post('/webhook-secrets').expect(401);
  });

  it('hides secrets from a connection without tenant context', async () => {
    const client = new Client({ connectionString: ctx.db.url });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT * FROM webhook_secrets');
      expect(rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});
