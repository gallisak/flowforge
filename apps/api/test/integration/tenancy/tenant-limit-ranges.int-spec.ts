import { Client } from 'pg';
import { useIntegrationContext } from '../../support/context';
import { seedTenant } from '../../support/db';

describe('tenant limits in the database', () => {
  const ctx = useIntegrationContext();
  let app: Client;

  beforeAll(async () => {
    app = new Client({ connectionString: ctx.db.url });
    await app.connect();
    ctx.onTeardown(() => app.end());
  });

  it.each([
    ['maxConcurrentJobs', -1],
    ['maxConcurrentJobs', 0],
    ['maxQueuedJobs', 0],
    ['rateLimitPerMinute', -5],
  ])('refuse %s = %d even when set without the API', async (field, value) => {
    const { tenant } = await seedTenant(ctx.ds, `limits-${field}-${value}`);

    await expect(app.query('SELECT * FROM set_tenant_limits($1, $2::jsonb)', [tenant.id, JSON.stringify({ [field]: value })])).rejects.toThrow(
      /CHK_tenants_limits/,
    );
  });

  it('accepts clearing a limit back to the default', async () => {
    const { tenant } = await seedTenant(ctx.ds, 'limits-cleared');

    const { rows } = await app.query('SELECT * FROM set_tenant_limits($1, $2::jsonb)', [tenant.id, JSON.stringify({ maxConcurrentJobs: null })]);

    expect(rows[0].maxConcurrentJobs).toBeNull();
  });
});
