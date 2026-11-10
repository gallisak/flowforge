import { INestApplication } from '@nestjs/common';
import crypto from 'crypto';
import request from 'supertest';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { createWebhookTarget, signWebhook, WebhookTarget } from '../../support/webhooks';

describe('F-12 webhook signatures are compared in constant time', () => {
  useIntegrationContext();
  let app: INestApplication;
  let target: WebhookTarget;
  const body = '{"event":"order.paid"}';

  const deliver = (headers: Record<string, string>) =>
    request(app.getHttpServer()).post(`/hooks/${target.workflowId}`).set('content-type', 'application/json').set(headers).send(body);

  const flipMiddle = (value: string) => {
    const middle = Math.floor(value.length / 2);
    return value.slice(0, middle) + (value[middle] === '0' ? '1' : '0') + value.slice(middle + 1);
  };
  const signatureHeader = (headers: Record<string, string>) => Object.keys(headers).find((name) => name.endsWith('signature')) ?? '';
  const tampered = (headers: Record<string, string>) => ({ ...headers, [signatureHeader(headers)]: flipMiddle(headers[signatureHeader(headers)]) });

  beforeAll(async () => {
    app = await createTestApp();
    target = await createWebhookTarget(app, 'constant-time');
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
  });

  it('compares a valid signature with timingSafeEqual', async () => {
    const compare = jest.spyOn(crypto, 'timingSafeEqual');

    await deliver(signWebhook(target.webhookSecret, body)).expect(202);

    expect(compare).toHaveBeenCalled();
  });

  it('compares a forged signature of the right length with timingSafeEqual', async () => {
    const compare = jest.spyOn(crypto, 'timingSafeEqual');

    await deliver(tampered(signWebhook(target.webhookSecret, body))).expect(401);

    expect(compare).toHaveBeenCalled();
  });

  it('rejects a signature of the wrong length without failing', async () => {
    const headers = signWebhook(target.webhookSecret, body);
    const short = { ...headers, [signatureHeader(headers)]: headers[signatureHeader(headers)].slice(0, 10) };

    await deliver(short).expect(401);
  });
});
