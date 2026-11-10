import { INestApplication } from '@nestjs/common';
import { createHmac } from 'crypto';
import request from 'supertest';

export interface WebhookTarget {
  apiKey: string;
  webhookSecret: string;
  workflowId: string;
}

export async function createWebhookTarget(app: INestApplication, name: string): Promise<WebhookTarget> {
  const server = app.getHttpServer();
  const tenant = await request(server)
    .post('/tenants')
    .set('x-admin-token', process.env.ADMIN_TOKEN ?? '')
    .send({ name })
    .expect(201);
  const workflow = await request(server)
    .post('/workflows')
    .set('x-api-key', tenant.body.apiKey)
    .send({ name: `${name}-hook`, steps: [{ id: 'note', type: 'log', message: 'received {{ input.event }}' }] })
    .expect(201);
  return { apiKey: tenant.body.apiKey, webhookSecret: tenant.body.webhookSecret, workflowId: workflow.body.id };
}

export interface WebhookDelivery {
  id?: string;
  timestamp?: number;
}

export function signWebhook(secret: string, body: string, _delivery: WebhookDelivery = {}): Record<string, string> {
  return { 'x-signature': createHmac('sha256', secret).update(body).digest('hex') };
}
