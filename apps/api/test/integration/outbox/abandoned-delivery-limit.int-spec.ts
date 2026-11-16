import { DataSource } from 'typeorm';
import { TenantDb } from '../../../src/db/tenant-db.service';
import { Execution, OutboxEvent } from '../../../src/entities';
import { useIntegrationContext } from '../../support/context';
import { openDataSource, seedTenant, seedWorkflow } from '../../support/db';

describe('claiming notifications a crashed dispatcher left behind', () => {
  const ctx = useIntegrationContext();
  let appDs: DataSource;

  beforeAll(async () => {
    appDs = await openDataSource(ctx.db.url);
  });

  afterAll(async () => {
    await appDs?.destroy();
  });

  async function abandoned(name: string, count: number): Promise<string> {
    const { tenant } = await seedTenant(ctx.ds, name);
    const workflow = await seedWorkflow(ctx.ds, tenant.id, [{ id: 'note', type: 'log', message: 'x' }]);
    const executions = await ctx.ds
      .getRepository(Execution)
      .save(Array.from({ length: count }, () => ({ tenantId: tenant.id, workflowId: workflow.id, input: {}, status: 'succeeded' as const })));
    await ctx.ds.getRepository(OutboxEvent).insert(
      executions.map((execution) => ({
        tenantId: tenant.id,
        executionId: execution.id,
        type: 'execution.succeeded',
        payload: {},
        status: 'delivering' as const,
        attempts: 1,
        lockedBy: 'crashed-dispatcher',
        lockedUntil: new Date(Date.now() - 60_000),
      })),
    );
    return tenant.id;
  }

  it('re-sends no more of one tenant at once than the per-tenant limit allows', async () => {
    const crowded = await abandoned('crowded', 10);
    const other = await abandoned('other', 1);

    const claimed = await new TenantDb(appDs).claimOutboxEvents('dispatcher-new', 30, 20, 2);

    expect(claimed.filter((event) => event.tenantId === crowded)).toHaveLength(2);
    expect(claimed.filter((event) => event.tenantId === other)).toHaveLength(1);
  });
});
