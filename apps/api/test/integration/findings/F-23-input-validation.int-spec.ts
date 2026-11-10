import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Workflow } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow, SeededTenant } from '../../support/db';

const VALID_STEPS = [{ id: 'hello', type: 'log', message: 'hi' }];
const INTERNAL_DETAILS = /QueryFailedError|TypeORMError|violates|relation "|SELECT |INSERT |\bat \w+ \(/;

describe('F-23 the API validates input at the boundary', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;
  let workflow: Workflow;

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'validation');
    workflow = await seedWorkflow(ctx.ds, tenant.tenant.id, [{ id: 'hello', type: 'log', message: 'hi' }]);
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => app.getHttpServer();

  function expectRejected(res: request.Response): void {
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(INTERNAL_DETAILS);
  }

  describe('creating a workflow', () => {
    it.each([
      ['without a name', { steps: VALID_STEPS }],
      ['with an empty name', { name: '', steps: VALID_STEPS }],
      ['with a name longer than 200 characters', { name: 'x'.repeat(201), steps: VALID_STEPS }],
      ['with a non-boolean enabled flag', { name: 'wf', steps: VALID_STEPS, enabled: 'yes' }],
      ['with an invalid cron expression', { name: 'wf', steps: VALID_STEPS, cron: 'not a cron' }],
      ['with a cron that fires every second', { name: 'wf', steps: VALID_STEPS, cron: '* * * * * *' }],
      ['with a cron that fires every 30 seconds', { name: 'wf', steps: VALID_STEPS, cron: '*/30 * * * * *' }],
      ['with an unknown timezone', { name: 'wf', steps: VALID_STEPS, timezone: 'Mars/Phobos' }],
      ['with an unsupported http method', { name: 'wf', steps: [{ id: 'call', type: 'http', url: 'https://example.com', method: 'TRACE' }] }],
      ['with non-string http header values', { name: 'wf', steps: [{ id: 'call', type: 'http', url: 'https://example.com', headers: { 'x-count': 1 } }] }],
      ['with a non-string http body', { name: 'wf', steps: [{ id: 'call', type: 'http', url: 'https://example.com', method: 'POST', body: { a: 1 } }] }],
      ['with a transform expression longer than 4 KB', { name: 'wf', steps: [{ id: 'shape', type: 'transform', expr: `(${'1+'.repeat(2100)}1)` }] }],
      ['with a log message longer than 2 KB', { name: 'wf', steps: [{ id: 'note', type: 'log', message: 'x'.repeat(2049) }] }],
    ])('rejects a workflow %s with 400', async (_case, body) => {
      expectRejected(await request(server()).post('/workflows').set('x-api-key', tenant.apiKey).send(body));
    });

    it('stores nothing when the input is rejected', async () => {
      await request(server()).post('/workflows').set('x-api-key', tenant.apiKey).send({ steps: VALID_STEPS });
      expect(await ctx.ds.getRepository(Workflow).countBy({ tenantId: tenant.tenant.id })).toBe(1);
    });
  });

  describe('updating a workflow', () => {
    it.each([
      ['an invalid cron expression', { cron: 'every day' }],
      ['an unknown timezone', { timezone: 'Not/AZone' }],
      ['an empty name', { name: '' }],
    ])('rejects %s with 400 and keeps the workflow unchanged', async (_case, body) => {
      expectRejected(await request(server()).patch(`/workflows/${workflow.id}`).set('x-api-key', tenant.apiKey).send(body));
      const stored = await ctx.ds.getRepository(Workflow).findOneByOrFail({ id: workflow.id });
      expect(stored).toMatchObject({ name: 'test-workflow', cron: null, timezone: 'UTC' });
    });
  });

  describe('listing executions', () => {
    it.each(['abc', '-5', '0', '1.5', '201'])('rejects limit=%s with 400', async (limit) => {
      expectRejected(await request(server()).get(`/executions?limit=${limit}`).set('x-api-key', tenant.apiKey));
    });

    it('accepts a limit within 1..200', async () => {
      await request(server()).get('/executions?limit=200').set('x-api-key', tenant.apiKey).expect(200);
    });
  });

  describe('running a workflow', () => {
    it('rejects an input that is not a JSON object with 400', async () => {
      expectRejected(
        await request(server()).post(`/workflows/${workflow.id}/run`).set('x-api-key', tenant.apiKey).send([1, 2, 3]),
      );
    });
  });
});
