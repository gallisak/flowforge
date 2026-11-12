import { Client } from 'pg';
import { Execution } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant, seedWorkflow } from '../../support/db';

describe('rows of one tenant that point at another tenant (application role)', () => {
  const ctx = useIntegrationContext();
  let tenantA: SeededTenant;
  let foreignExecution: Execution;
  let app: Client;

  async function insertAsTenantA(sql: string, params: unknown[]): Promise<string | undefined> {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA.tenant.id]);
      await app.query(sql, params);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    } finally {
      await app.query('ROLLBACK');
    }
  }

  beforeAll(async () => {
    tenantA = await seedTenant(ctx.ds, 'reference-a');
    const tenantB = await seedTenant(ctx.ds, 'reference-b');
    const workflow = await seedWorkflow(ctx.ds, tenantB.tenant.id, [{ id: 'hello', type: 'log', message: 'hi' }]);
    foreignExecution = await ctx.ds.getRepository(Execution).save({ tenantId: tenantB.tenant.id, workflowId: workflow.id, input: {} });
    app = new Client({ connectionString: ctx.db.url });
    await app.connect();
    ctx.onTeardown(() => app.end());
  });

  it.each([
    ['step_runs', `INSERT INTO "step_runs" ("tenantId", "executionId", "stepIndex", "stepId") VALUES ($1, $2, 0, 'hello')`],
    ['jobs', `INSERT INTO "jobs" ("tenantId", "executionId") VALUES ($1, $2)`],
    ['outbox_events', `INSERT INTO "outbox_events" ("tenantId", "executionId", "type", "payload") VALUES ($1, $2, 'execution.succeeded', '{}')`],
  ])('cannot be written into %s', async (_table, sql) => {
    expect(await insertAsTenantA(sql, [tenantA.tenant.id, foreignExecution.id])).toBe('23503');
  });
});
