import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { notificationBody } from '../../../src/outbox/outbox-dispatcher.service';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { eventually } from '../../support/eventually';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

interface Schema {
  $ref?: string;
  allOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
}

interface PathItem {
  servers?: unknown[];
  [method: string]: unknown;
}

interface OpenApiDocument {
  paths: Record<string, PathItem>;
  components: { schemas: Record<string, Schema> };
}

const DOCUMENT_PATH = join(__dirname, '..', '..', '..', '..', '..', 'docs', 'openapi.json');
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function loadDocument(): OpenApiDocument {
  return JSON.parse(readFileSync(DOCUMENT_PATH, 'utf8')) as OpenApiDocument;
}

function resolvePointer(document: unknown, pointer: string): unknown {
  return pointer
    .slice(2)
    .split('/')
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], document);
}

function referencesOf(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(referencesOf);
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) => (key === '$ref' && typeof value === 'string' ? [value] : referencesOf(value)));
  }
  return [];
}

function flatten(document: OpenApiDocument, schema: Schema): { properties: string[]; required: string[] } {
  if (schema.$ref) return flatten(document, resolvePointer(document, schema.$ref) as Schema);
  const parts = (schema.allOf ?? []).map((part) => flatten(document, part));
  return {
    properties: [...Object.keys(schema.properties ?? {}), ...parts.flatMap((p) => p.properties)].sort(),
    required: [...(schema.required ?? []), ...parts.flatMap((p) => p.required)].sort(),
  };
}

function routesOf(app: INestApplication): string[] {
  const router = (app.getHttpAdapter().getInstance() as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } })._router;
  return router.stack
    .flatMap((layer) => (layer.route ? Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route?.path}`) : []))
    .sort();
}

describe('OpenAPI document', () => {
  const ctx = useIntegrationContext();
  const document = loadDocument();
  let app: INestApplication;
  let workers: InProcessWorkers | undefined;

  const expectDocumented = (schemaName: string, body: Record<string, unknown>) => {
    const { properties, required } = flatten(document, document.components.schemas[schemaName]);
    expect({ schema: schemaName, keys: Object.keys(body).sort() }).toEqual({ schema: schemaName, keys: properties.filter((p) => p in body) });
    expect({ schema: schemaName, missing: required.filter((key) => !(key in body)) }).toEqual({ schema: schemaName, missing: [] });
    expect({ schema: schemaName, undocumented: Object.keys(body).filter((key) => !properties.includes(key)) }).toEqual({ schema: schemaName, undocumented: [] });
  };

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await workers?.stop();
    await app?.close();
  });

  it('describes exactly the routes the API serves', () => {
    const documented = Object.entries(document.paths)
      .filter(([, item]) => !item.servers)
      .flatMap(([path, item]) =>
        HTTP_METHODS.filter((method) => method in item).map((method) => `${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ':$1')}`),
      )
      .sort();

    expect(documented).toEqual(routesOf(app));
  });

  it('resolves every reference', () => {
    const unresolved = referencesOf(document).filter((pointer) => resolvePointer(document, pointer) === undefined);

    expect(unresolved).toEqual([]);
  });

  it('documents the fields the API actually returns', async () => {
    const server = app.getHttpServer();
    const tenant = await request(server)
      .post('/tenants')
      .set('x-admin-token', process.env.ADMIN_TOKEN as string)
      .send({ name: 'documented' })
      .expect(201);
    expectDocumented('CreatedTenant', tenant.body);
    const key = tenant.body.apiKey as string;

    const workflow = await request(server)
      .post('/workflows')
      .set('x-api-key', key)
      .send({ name: 'documented', steps: [{ id: 'note', type: 'log', message: 'hi' }] })
      .expect(201);
    expectDocumented('Workflow', workflow.body);

    const execution = await request(server).post(`/workflows/${workflow.body.id}/run`).set('x-api-key', key).send({ a: 1 }).expect(201);
    expectDocumented('Execution', execution.body);

    workers = await startInProcessWorkers(1);
    const detail = await eventually(async () => {
      const res = await request(server).get(`/executions/${execution.body.id}`).set('x-api-key', key).expect(200);
      expect(res.body.status).toBe('succeeded');
      return res.body as Record<string, unknown> & { steps: Record<string, unknown>[] };
    });
    expectDocumented('ExecutionDetail', detail);
    expectDocumented('StepRun', detail.steps[0]);

    const secret = await request(server).post('/webhook-secrets').set('x-api-key', key).expect(201);
    expectDocumented('CreatedSigningSecret', secret.body);
    const secrets = await request(server).get('/webhook-secrets').set('x-api-key', key).expect(200);
    expectDocumented('SigningSecret', secrets.body[0]);

    const endpoint = await request(server).put('/notifications/endpoint').set('x-api-key', key).send({ url: 'https://example.com/hooks' }).expect(200);
    expectDocumented('NotificationEndpoint', endpoint.body);

    const missing = await request(server).get(`/workflows/${execution.body.id}`).set('x-api-key', key).expect(404);
    expectDocumented('Error', missing.body);
  });

  it('documents the body of the notification the dispatcher sends', async () => {
    const server = app.getHttpServer();
    const tenant = await request(server).post('/tenants').set('x-admin-token', process.env.ADMIN_TOKEN as string).send({ name: 'notified' }).expect(201);
    const key = tenant.body.apiKey as string;
    await request(server).put('/notifications/endpoint').set('x-api-key', key).send({ url: 'https://example.com/hooks' }).expect(200);
    const workflow = await request(server)
      .post('/workflows')
      .set('x-api-key', key)
      .send({ name: 'notified', steps: [{ id: 'note', type: 'log', message: 'hi' }] })
      .expect(201);
    const execution = await request(server).post(`/workflows/${workflow.body.id}/run`).set('x-api-key', key).send({}).expect(201);
    workers ??= await startInProcessWorkers(1);

    const [event] = await eventually(async () => {
      const rows: Array<{ type: string; createdAt: Date; payload: Record<string, unknown> }> = await ctx.ds.query(
        `SELECT "type", "createdAt", "payload" FROM "outbox_events" WHERE "executionId" = $1`,
        [execution.body.id],
      );
      expect(rows).toHaveLength(1);
      return rows;
    });
    const body = JSON.parse(notificationBody(event)) as Record<string, unknown> & { data: Record<string, unknown> };
    const schema = resolvePointer(document, '#/webhooks/executionFinished/post/requestBody/content/application~1json/schema') as Schema;

    expect(Object.keys(body).sort()).toEqual(flatten(document, schema).properties);
    expectDocumented('ExecutionNotification', body.data);
  });
});
