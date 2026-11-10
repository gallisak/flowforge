import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, seedWorkflow, SeededTenant } from '../../support/db';

describe('F-02 execution list is isolated per tenant', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const executionsOf = new Map<string, string[]>();

  async function runWorkflow(seeded: SeededTenant, times: number): Promise<string[]> {
    const workflow = await seedWorkflow(ctx.ds, seeded.tenant.id, [{ id: 'hello', type: 'log', message: 'hi' }]);
    const ids: string[] = [];
    for (let i = 0; i < times; i++) {
      const res = await request(app.getHttpServer())
        .post(`/workflows/${workflow.id}/run`)
        .set('x-api-key', seeded.apiKey)
        .send({ i })
        .expect(201);
      ids.push(res.body.id);
    }
    return ids;
  }

  async function listedIds(seeded: SeededTenant): Promise<string[]> {
    const res = await request(app.getHttpServer()).get('/executions').set('x-api-key', seeded.apiKey).expect(200);
    return res.body.map((execution: { id: string }) => execution.id);
  }

  beforeAll(async () => {
    app = await createTestApp();
    tenantA = await seedTenant(ctx.ds, 'tenant-a');
    tenantB = await seedTenant(ctx.ds, 'tenant-b');
    executionsOf.set(tenantA.tenant.id, await runWorkflow(tenantA, 2));
    executionsOf.set(tenantB.tenant.id, await runWorkflow(tenantB, 3));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lists only the executions of the calling tenant', async () => {
    expect((await listedIds(tenantA)).sort()).toEqual([...(executionsOf.get(tenantA.tenant.id) ?? [])].sort());
    expect((await listedIds(tenantB)).sort()).toEqual([...(executionsOf.get(tenantB.tenant.id) ?? [])].sort());
  });

  it('never returns an execution owned by another tenant', async () => {
    const listedForA = await listedIds(tenantA);
    for (const foreignId of executionsOf.get(tenantB.tenant.id) ?? []) {
      expect(listedForA).not.toContain(foreignId);
    }
  });
});
