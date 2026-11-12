import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { getMetadataStorage } from 'class-validator';
import { EXECUTION_STATUSES, OUTBOX_EVENT_STATUSES } from '../../../src/entities';
import { ListExecutionsQuery } from '../../../src/executions/executions.controller';
import { NotificationEndpointDto } from '../../../src/notifications/notification-endpoint.dto';
import { ListNotificationEventsQuery } from '../../../src/notifications/notifications.controller';
import { notificationBody } from '../../../src/outbox/outbox-dispatcher.service';
import { MISSED_RUN_POLICIES } from '../../../src/scheduler/cron-schedule';
import { CreateTenantDto, UpdateTenantLimitsDto } from '../../../src/tenants/tenants.controller';
import { CreateWorkflowDto, UpdateWorkflowDto } from '../../../src/workflows/workflow.dto';
import { ListWorkflowsQuery } from '../../../src/workflows/workflows.controller';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { eventually } from '../../support/eventually';
import { InProcessWorkers, startInProcessWorkers } from '../../support/worker';

interface Schema {
  $ref?: string;
  enum?: string[];
  allOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
}

interface Operation {
  parameters?: Array<{ $ref?: string; name?: string; in?: string; schema?: Schema }>;
  responses: Record<string, unknown>;
}

interface PathItem {
  servers?: unknown[];
  [method: string]: unknown;
}

function propertiesOf(dto: abstract new () => unknown): string[] {
  return [...new Set(getMetadataStorage().getTargetValidationMetadatas(dto as new () => unknown, '', true, false).map((m) => m.propertyName))].sort();
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
  const { router } = app.getHttpAdapter().getInstance() as { router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } };
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
    const workflows = await request(server).get('/workflows').set('x-api-key', key).expect(200);
    expectDocumented('WorkflowSummary', workflows.body[0]);

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
    const executions = await request(server).get('/executions').set('x-api-key', key).expect(200);
    expectDocumented('ExecutionSummary', executions.body[0]);

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
    const listed = await request(server).get('/notifications/events').set('x-api-key', key).expect(200);
    expectDocumented('NotificationEvent', listed.body[0]);
  });

  it('documents the request bodies, query parameters and enums the API validates', () => {
    const bodies: Array<[string, abstract new () => unknown]> = [
      ['CreateWorkflow', CreateWorkflowDto],
      ['UpdateWorkflow', UpdateWorkflowDto],
      ['CreateTenant', CreateTenantDto],
      ['TenantLimits', UpdateTenantLimitsDto],
      ['NotificationEndpointRequest', NotificationEndpointDto],
    ];
    for (const [schema, dto] of bodies) {
      expect({ schema, properties: flatten(document, document.components.schemas[schema]).properties }).toEqual({ schema, properties: propertiesOf(dto) });
    }
    const queries: Array<[string, abstract new () => unknown]> = [
      ['/executions', ListExecutionsQuery],
      ['/workflows', ListWorkflowsQuery],
      ['/notifications/events', ListNotificationEventsQuery],
    ];
    for (const [path, dto] of queries) {
      const parameters = ((document.paths[path].get as Operation).parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name);
      expect({ path, parameters: parameters.sort() }).toEqual({ path, parameters: propertiesOf(dto) });
    }
    const statusParameter = (document.paths['/notifications/events'].get as Operation).parameters?.find((p) => p.name === 'status');
    expect(statusParameter?.schema?.enum).toEqual([...OUTBOX_EVENT_STATUSES]);
    expect(document.components.schemas.ExecutionStatus.enum).toEqual([...EXECUTION_STATUSES]);
    expect(document.components.schemas.MissedRunPolicy.enum).toEqual([...MISSED_RUN_POLICIES]);
  });

  it('documents every status code the API answers in common failure cases', async () => {
    const server = app.getHttpServer();
    const tenant = await request(server).post('/tenants').set('x-admin-token', process.env.ADMIN_TOKEN as string).send({ name: 'codes' }).expect(201);
    const key = tenant.body.apiKey as string;
    const unknown = '00000000-0000-4000-8000-000000000000';
    const existing = await request(server)
      .post('/workflows')
      .set('x-api-key', key)
      .send({ name: 'codes', steps: [{ id: 'note', type: 'log', message: 'hi' }] })
      .expect(201);
    const probes: Array<[string, string, () => request.Test]> = [
      ['patch', '/workflows/{id}', () => request(server).patch(`/workflows/${existing.body.id}`).set('x-api-key', key).set('if-match', '"999"').send({ name: 'y' })],
      ['post', '/workflows', () => request(server).post('/workflows').set('x-api-key', key).send({ name: 'x' })],
      ['post', '/workflows', () => request(server).post('/workflows').send({})],
      ['post', '/workflows', () => request(server).post('/workflows').set('x-api-key', key).set('content-type', 'text/plain').send('{}')],
      ['get', '/executions', () => request(server).get('/executions?limit=0').set('x-api-key', key)],
      ['get', '/executions/{id}', () => request(server).get(`/executions/${unknown}`).set('x-api-key', key)],
      ['get', '/executions/{id}/output', () => request(server).get(`/executions/${unknown}/output`).set('x-api-key', key)],
      ['get', '/executions/{id}/steps/{stepIndex}/output', () => request(server).get(`/executions/${unknown}/steps/x/output`).set('x-api-key', key)],
      ['post', '/tenants', () => request(server).post('/tenants').set('x-admin-token', 'wrong').send({ name: 'codes' })],
      ['patch', '/workflows/{id}', () => request(server).patch(`/workflows/${unknown}`).set('x-api-key', key).send({ name: 'x' })],
      ['patch', '/workflows/{id}', () => request(server).patch(`/workflows/${unknown}`).set('x-api-key', key).send({ name: 'x', enable: false })],
      ['post', '/workflows/{id}/run', () => request(server).post(`/workflows/${unknown}/run`).set('x-api-key', key).send({})],
      ['post', '/hooks/{workflowId}', () => request(server).post(`/hooks/${unknown}`).set('content-type', 'application/json').send('{}')],
    ];
    const undocumented: string[] = [];
    for (const [method, path, send] of probes) {
      const response = await send();
      const operation = document.paths[path][method] as Operation;
      if (!(String(response.status) in operation.responses)) undocumented.push(`${method.toUpperCase()} ${path} ${response.status}`);
    }

    expect(undocumented).toEqual([]);
  });

  it('documents the answers to oversized and non-JSON bodies on every operation that accepts a body', async () => {
    const server = app.getHttpServer();
    const unknown = '00000000-0000-4000-8000-000000000000';
    const oversized = JSON.stringify({ name: 'x'.repeat(200 * 1024) });
    const undocumented: string[] = [];
    for (const [path, item] of Object.entries(document.paths).filter(([, entry]) => !entry.servers)) {
      for (const method of ['post', 'put', 'patch'].filter((name) => name in item)) {
        const url = path.replace(/\{[^}]+\}/g, unknown);
        const operation = item[method] as Operation;
        const send = () => (request(server) as unknown as Record<string, (url: string) => request.Test>)[method](url);
        const tooLarge = await send().set('content-type', 'application/json').send(oversized);
        const notJson = await send().set('content-type', 'text/plain').send('x');
        for (const status of [tooLarge.status, notJson.status]) {
          if (!(String(status) in operation.responses)) undocumented.push(`${method.toUpperCase()} ${path} ${status}`);
        }
      }
    }

    expect(undocumented).toEqual([]);
  });
});
