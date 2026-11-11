import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Execution } from '../../../src/entities';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant, seedWorkflow } from '../../support/db';

describe('execution list with cursor pagination', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;
  let workflowIds: string[];

  const list = (query: Record<string, string>, apiKey = tenant.apiKey) =>
    request(app.getHttpServer()).get('/executions').query(query).set('x-api-key', apiKey);

  async function pageThrough(query: Record<string, string>, between?: () => Promise<void>): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await list({ ...query, ...(cursor ? { cursor } : {}) }).expect(200);
      ids.push(...res.body.map((e: Execution) => e.id));
      cursor = res.headers['x-next-cursor'];
      if (between) await between();
    } while (cursor);
    return ids;
  }

  async function insertAt(createdAt: string, workflowId: string, status: string): Promise<string> {
    const [row]: Array<{ id: string }> = await ctx.ds.query(
      `INSERT INTO executions ("tenantId", "workflowId", status, input, "createdAt") VALUES ($1, $2, $3, '{}', $4) RETURNING id`,
      [tenant.tenant.id, workflowId, status, createdAt],
    );
    return row.id;
  }

  const expectedOrder = async (where = '') =>
    (
      await ctx.ds.query(
        `SELECT id FROM executions WHERE "tenantId" = $1 ${where} ORDER BY "createdAt" DESC, id DESC`,
        [tenant.tenant.id],
      )
    ).map((row: { id: string }) => row.id);

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'paged');
    workflowIds = [];
    for (const name of ['a', 'b']) workflowIds.push((await seedWorkflow(ctx.ds, tenant.tenant.id, [{ id: name, type: 'log', message: name }])).id);
    const statuses = ['succeeded', 'failed', 'running'];
    for (let i = 0; i < 25; i++) {
      const sharedSecond = i % 5 === 0 ? '2026-11-20 10:00:00.123456' : `2026-11-20 10:00:${String(10 + i).padStart(2, '0')}.000001`;
      await insertAt(sharedSecond, workflowIds[i % 2], statuses[i % 3]);
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns every execution exactly once in creation order, including ones created at the same instant', async () => {
    const ids = await pageThrough({ limit: '4' });

    expect(ids).toEqual(await expectedOrder());
    expect(new Set(ids).size).toBe(25);
  });

  it('neither skips nor repeats rows when new executions arrive between pages', async () => {
    const before = await expectedOrder();
    let minute = 0;

    const ids = await pageThrough({ limit: '6' }, async () => {
      await insertAt(`2026-11-21 0${minute++}:00:00`, workflowIds[0], 'pending');
    });

    expect(ids).toEqual(before);
  });

  it('filters by status and by workflow', async () => {
    const failed = await pageThrough({ limit: '3', status: 'failed' });
    const ofFirst = await pageThrough({ limit: '3', workflowId: workflowIds[1] });

    expect(failed).toEqual(await expectedOrder(`AND status = 'failed'`));
    expect(ofFirst).toEqual(await expectedOrder(`AND "workflowId" = '${workflowIds[1]}'`));
  });

  it('omits the next cursor on the last page', async () => {
    const res = await list({ limit: '200' }).expect(200);

    expect(res.headers['x-next-cursor']).toBeUndefined();
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['a valid encoding of a wrong shape', Buffer.from('{"a":1}').toString('base64url')],
    ['an injected timestamp', Buffer.from(JSON.stringify(["2026-01-01'); DROP TABLE executions; --", '00000000-0000-0000-0000-000000000000'])).toString('base64url')],
  ])('rejects %s as a cursor', async (_case, cursor) => {
    const res = await list({ cursor });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('cursor is invalid');
  });

  it('rejects an unknown status filter', async () => {
    await list({ status: 'exploded' }).expect(400);
  });

  it('does not reveal executions of another tenant through a cursor', async () => {
    const first = await list({ limit: '2' }).expect(200);
    const other = await seedTenant(ctx.ds, 'other-paged');

    const res = await list({ cursor: first.headers['x-next-cursor'] }, other.apiKey).expect(200);

    expect(res.body).toEqual([]);
  });
});
