import { Execution, Job } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant, seedWorkflow } from '../../support/db';
import { eventually } from '../../support/eventually';
import { Receiver, startReceiver } from '../../support/receiver';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

describe('F-29 input values cannot change the structure of an http step body', () => {
  const ctx = useIntegrationContext();
  let receiver: Receiver;
  let workers: InProcessWorkers;
  let tenant: SeededTenant;

  async function bodySentFor(body: string, input: Record<string, unknown>, headers: Record<string, string>): Promise<string> {
    const workflow = await seedWorkflow(ctx.ds, tenant.tenant.id, [
      { id: 'call', type: 'http', method: 'POST', url: `${receiver.url}/accounts`, headers, body },
    ]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.tenant.id, workflowId: workflow.id, input });
    await ctx.ds.getRepository(Job).save({ tenantId: tenant.tenant.id, executionId: execution.id });
    await eventually(async () =>
      expect(await ctx.ds.getRepository(Execution).findOneByOrFail({ id: execution.id })).toMatchObject({ status: 'succeeded' }),
    );
    const received = receiver.requests.find((r) => r.headers['idempotency-key'] === `${execution.id}:call`);
    return received?.body ?? '';
  }

  const json = { 'content-type': 'application/json' };

  beforeAll(async () => {
    receiver = await startReceiver();
    tenant = await seedTenant(ctx.ds, 'body-templates');
    workers = await startInProcessWorkers(1);
  });

  afterAll(async () => {
    await workers?.stop();
    await receiver?.close();
  });

  it('keeps a value inside its JSON string', async () => {
    const sent = await bodySentFor('{"role":"viewer","name":"{{ input.name }}"}', { name: 'x","role":"admin' }, json);

    expect(JSON.parse(sent)).toEqual({ role: 'viewer', name: 'x","role":"admin' });
  });

  it('keeps a value in a JSON value position from adding fields', async () => {
    const sent = await bodySentFor('{"count":{{ input.count }}}', { count: '1,"admin":true' }, json);

    expect(JSON.parse(sent)).toEqual({ count: '1,"admin":true' });
  });

  it('inserts numbers, booleans and objects as JSON values', async () => {
    const sent = await bodySentFor(
      '{"count":{{ input.count }},"active":{{ input.active }},"tags":{{ input.tags }},"label":"n={{ input.count }}"}',
      { count: 5, active: true, tags: ['a', 'b'] },
      json,
    );

    expect(JSON.parse(sent)).toEqual({ count: 5, active: true, tags: ['a', 'b'], label: 'n=5' });
  });

  it('keeps a value inside its form field', async () => {
    const sent = await bodySentFor(
      'name={{ input.name }}&role=viewer',
      { name: 'x&role=admin' },
      { 'content-type': 'application/x-www-form-urlencoded' },
    );

    expect(Object.fromEntries(new URLSearchParams(sent))).toEqual({ name: 'x&role=admin', role: 'viewer' });
  });
});
