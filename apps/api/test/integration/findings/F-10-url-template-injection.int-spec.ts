import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Execution, Job } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('F-10 input values cannot change where an http step goes', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let receiver: Receiver;
  let workers: InProcessWorkers;
  let tenant: SeededTenant;

  async function requestPathFor(url: string, input: Record<string, unknown>): Promise<string> {
    const workflow = await seedWorkflow(ctx.ds, tenant.tenant.id, [{ id: 'call', type: 'http', url }]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.tenant.id, workflowId: workflow.id, input });
    await ctx.ds.getRepository(Job).save({ tenantId: tenant.tenant.id, executionId: execution.id });
    await eventually(async () =>
      expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'succeeded' }),
    );
    const received = receiver.requests.find((r) => r.headers['idempotency-key'] === `${execution.id}:call`);
    return received?.path ?? '';
  }

  beforeAll(async () => {
    app = await createTestApp();
    receiver = await startReceiver();
    tenant = await seedTenant(ctx.ds, 'url-templates');
    workers = await startInProcessWorkers(1);
  });

  afterAll(async () => {
    await workers?.stop();
    await app?.close();
    await receiver?.close();
  });

  it('keeps a value inside its path segment', async () => {
    const path = await requestPathFor(`${receiver.url}/users/{{ input.id }}/profile`, { id: '../../admin?all=1#' });

    expect(path).toBe('/users/..%2F..%2Fadmin%3Fall%3D1%23/profile');
  });

  it('keeps a value inside its query parameter', async () => {
    const path = await requestPathFor(`${receiver.url}/search?q={{ input.q }}&limit=10`, { q: 'shoes&limit=100000&admin=true' });

    expect(path).toBe('/search?q=shoes%26limit%3D100000%26admin%3Dtrue&limit=10');
  });

  it('does not expose members inherited from the prototype', async () => {
    const path = await requestPathFor(`${receiver.url}/echo/{{ input.constructor }}`, {});

    expect(path).toBe('/echo/');
  });

  it.each([
    'https://api.example.com{{ input.path }}',
    'https://{{ input.subdomain }}.example.com/items',
    'https://api.example.com:{{ input.port }}/items',
    '{{ input.callbackUrl }}',
  ])('rejects a workflow whose url template lets input choose the origin: %s', async (url) => {
    const response = await request(app.getHttpServer())
      .post('/workflows')
      .set('x-api-key', tenant.apiKey)
      .send({ name: 'origin-from-input', steps: [{ id: 'call', type: 'http', url }] });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/url/);
  });
});
