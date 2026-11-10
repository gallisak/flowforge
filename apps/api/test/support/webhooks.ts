import { INestApplication } from '@nestjs/common';
import { createHmac, randomUUID } from 'crypto';
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

export function signWebhook(secret: string, body: string, delivery: WebhookDelivery = {}): Record<string, string> {
  const id = delivery.id ?? `msg_${randomUUID()}`;
  const timestamp = String(delivery.timestamp ?? Math.floor(Date.now() / 1000));
  const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice('whsec_'.length), 'base64') : Buffer.from(secret);
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
}
