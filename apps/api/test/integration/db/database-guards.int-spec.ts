import { DataSource } from 'typeorm';
import { TenantDb } from '../../../src/db/tenant-db.service';
import { dataSourceOptions } from '../../../src/db/data-source';
import { Execution, WorkflowVersion } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow } from '../../support/db';
import { DB_ROLES, withCredentials } from '../../support/schema';

describe('database guards', () => {
  const ctx = useIntegrationContext();
  let app: DataSource;

  beforeAll(async () => {
    app = await new DataSource(dataSourceOptions(withCredentials(ctx.db.url, DB_ROLES.app))).initialize();
  });

  afterAll(async () => {
    await app?.destroy();
  });

  it.each([
    ['no retention', `interval '0 days'`, 100],
    ['a negative retention', `interval '-1 day'`, 100],
    ['an unbounded batch', `interval '30 days'`, 1_000_000],
  ])('refuses to purge with %s even when the application role asks', async (_case, retention, batch) => {
    await expect(app.query(`SELECT * FROM purge_finished_data(${retention}, $1)`, [batch])).rejects.toThrow(/at least one day|between 1 and 10000/);
  });

  it.each([
    ['jobs', `UPDATE jobs SET status = 'paused'`],
    ['executions', `UPDATE executions SET status = 'done'`],
    ['executions', `UPDATE executions SET trigger = 'manual'`],
    ['step_runs', `UPDATE step_runs SET status = 'done'`],
  ])('rejects an unknown state in %s', async (_table, statement) => {
    const { tenant } = await seedTenant(ctx.ds, `states-${Math.random()}`);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'note', type: 'log', message: 'x' }]);
    const execution = await ctx.ds.getRepository(Execution).save({ tenantId: tenant.id, workflowId: workflow.id, workflowVersion: 1, input: {}, trigger: 'api' });
    await ctx.ds.query(`INSERT INTO jobs ("tenantId", "executionId") VALUES ($1, $2)`, [tenant.id, execution.id]);
    await ctx.ds.query(
      `INSERT INTO step_runs ("tenantId", "executionId", "stepIndex", "stepId", "status") VALUES ($1, $2, 0, 'note', 'running')`,
      [tenant.id, execution.id],
    );

    await expect(ctx.ds.query(`${statement} WHERE "tenantId" = $1`, [tenant.id])).rejects.toThrow(/check constraint/);
  });

  it('does not let a version row written under another tenant block the next version of a workflow', async () => {
    const owner = await seedTenant(ctx.ds, 'version-owner');
    const intruder = await seedTenant(ctx.ds, 'version-intruder');
    const workflow = await seedWorkflow(ctx.ds, owner.tenant.id, [{ id: 'note', type: 'log', message: 'x' }]);
    const tenantDb = new TenantDb(app);
    await tenantDb.run(intruder.tenant.id, (em) =>
      em.insert(WorkflowVersion, { tenantId: intruder.tenant.id, workflowId: workflow.id, version: 2, steps: [] }),
    );

    await expect(
      tenantDb.run(owner.tenant.id, (em) => em.insert(WorkflowVersion, { tenantId: owner.tenant.id, workflowId: workflow.id, version: 2, steps: [] })),
    ).resolves.toBeDefined();
  });
});
