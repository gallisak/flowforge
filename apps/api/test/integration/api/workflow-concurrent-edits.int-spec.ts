import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { seedTenant, SeededTenant } from '../../support/db';

const CONFLICT_MESSAGE = 'The workflow was changed by someone else; reload it and try again';

describe('concurrent workflow edits', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;
  let tenant: SeededTenant;
  const api = () => request(app.getHttpServer());
  const steps = (message: string) => [{ id: 'note', type: 'log', message }];

  async function createWorkflow(): Promise<string> {
    const created = await api().post('/workflows').set('x-api-key', tenant.apiKey).send({ name: 'edited', steps: steps('v1') }).expect(201);
    return created.body.id as string;
  }

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await seedTenant(ctx.ds, 'concurrent-edits');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('tags a workflow with its revision', async () => {
    const id = await createWorkflow();

    const res = await api().get(`/workflows/${id}`).set('x-api-key', tenant.apiKey).expect(200);

    expect(res.headers.etag).toBe('"1"');
  });

  it('refuses the second of two edits made from the same version', async () => {
    const id = await createWorkflow();
    const loaded = await api().get(`/workflows/${id}`).set('x-api-key', tenant.apiKey).expect(200);
    const etag = loaded.headers.etag as string;

    const first = await api().patch(`/workflows/${id}`).set('x-api-key', tenant.apiKey).set('if-match', etag).send({ steps: steps('first') }).expect(200);
    expect(first.headers.etag).toBe('"2"');
    const second = await api().patch(`/workflows/${id}`).set('x-api-key', tenant.apiKey).set('if-match', etag).send({ steps: steps('second') }).expect(412);

    expect(second.body.message).toBe(CONFLICT_MESSAGE);
    const current = await api().get(`/workflows/${id}`).set('x-api-key', tenant.apiKey).expect(200);
    expect(current.body.steps).toEqual(steps('first'));
  });

  it('refuses the second of two renames made from the same tag, although the steps did not change', async () => {
    const id = await createWorkflow();
    const etag = (await api().get(`/workflows/${id}`).set('x-api-key', tenant.apiKey).expect(200)).headers.etag;

    const first = await api().patch(`/workflows/${id}`).set('x-api-key', tenant.apiKey).set('if-match', etag).send({ name: 'first' }).expect(200);
    expect(first.headers.etag).toBe('"2"');
    expect(first.body).toMatchObject({ version: 1, revision: 2 });
    await api().patch(`/workflows/${id}`).set('x-api-key', tenant.apiKey).set('if-match', etag).send({ cron: '0 9 * * *' }).expect(412);

    const current = await api().get(`/workflows/${id}`).set('x-api-key', tenant.apiKey).expect(200);
    expect(current.body).toMatchObject({ name: 'first', cron: null });
  });

  it('keeps the tag when a change sets the values the workflow already has', async () => {
    const id = await createWorkflow();

    const res = await api().patch(`/workflows/${id}`).set('x-api-key', tenant.apiKey).set('if-match', '"1"').send({ name: 'edited' }).expect(200);

    expect(res.headers.etag).toBe('"1"');
  });

  it.each(['W/"1"', '*', '"7", "1"'])('accepts the matching precondition %s', async (ifMatch) => {
    const id = await createWorkflow();

    await api().patch(`/workflows/${id}`).set('x-api-key', tenant.apiKey).set('if-match', ifMatch).send({ name: 'renamed' }).expect(200);
  });

  it.each(['"2"', 'W/"0"', '1', 'garbage'])('refuses the precondition %s that does not match', async (ifMatch) => {
    const id = await createWorkflow();

    const res = await api().patch(`/workflows/${id}`).set('x-api-key', tenant.apiKey).set('if-match', ifMatch).send({ name: 'renamed' }).expect(412);

    expect(res.body.message).toBe(CONFLICT_MESSAGE);
    const current = await api().get(`/workflows/${id}`).set('x-api-key', tenant.apiKey).expect(200);
    expect(current.body.name).toBe('edited');
  });

  it('keeps editing without a precondition', async () => {
    const id = await createWorkflow();
    await api().patch(`/workflows/${id}`).set('x-api-key', tenant.apiKey).send({ steps: steps('v2') }).expect(200);

    await api().patch(`/workflows/${id}`).set('x-api-key', tenant.apiKey).send({ steps: steps('v3') }).expect(200);
  });

  it('answers 404 rather than 412 for a workflow that does not exist', async () => {
    await api().patch('/workflows/00000000-0000-4000-8000-000000000000').set('x-api-key', tenant.apiKey).set('if-match', '"1"').send({ name: 'x' }).expect(404);
  });
});
