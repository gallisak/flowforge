import { notificationBody, notificationHeaders } from '../src/outbox/outbox-dispatcher.service';
import { generateWebhookSecret } from '../src/webhooks/webhook-secrets.service';
import { verifyWebhook } from '../src/webhooks/signature';

const event = {
  id: '7d2c8a76-0c49-4d3e-9a43-5c1f3b1f9a10',
  type: 'execution.succeeded',
  createdAt: new Date('2026-11-20T09:00:00Z'),
  payload: { executionId: 'e-1', status: 'succeeded' },
  correlationId: 'trace-1',
};

describe('notification signing', () => {
  it('produces a body with the event type, its creation time and the payload', () => {
    expect(JSON.parse(notificationBody(event))).toEqual({ type: 'execution.succeeded', timestamp: '2026-11-20T09:00:00.000Z', data: event.payload });
  });

  it('signs the body so that the receiver can verify it with the Standard Webhooks scheme', () => {
    const secret = generateWebhookSecret();
    const body = notificationBody(event);
    const now = 1_795_000_000;

    const headers = notificationHeaders(event, body, [secret], now);

    expect(headers).toMatchObject({ 'webhook-id': event.id, 'webhook-timestamp': String(now), 'X-Correlation-Id': 'trace-1' });
    expect(
      verifyWebhook([secret], { id: headers['webhook-id'], timestamp: headers['webhook-timestamp'], signature: headers['webhook-signature'] }, Buffer.from(body), now, 300),
    ).toBe(event.id);
  });

  it('adds one signature per active secret so that a rotation needs no downtime', () => {
    const [oldSecret, newSecret] = [generateWebhookSecret(), generateWebhookSecret()];
    const body = notificationBody(event);

    const headers = notificationHeaders(event, body, [newSecret, oldSecret], 1_795_000_000);
    const verifyWith = (secret: string) =>
      verifyWebhook(
        [secret],
        { id: headers['webhook-id'], timestamp: headers['webhook-timestamp'], signature: headers['webhook-signature'] },
        Buffer.from(body),
        1_795_000_000,
        300,
      );

    expect(headers['webhook-signature'].split(' ')).toHaveLength(2);
    expect(verifyWith(oldSecret)).toBe(event.id);
    expect(verifyWith(newSecret)).toBe(event.id);
  });

  it('does not verify against a changed body', () => {
    const secret = generateWebhookSecret();
    const headers = notificationHeaders(event, notificationBody(event), [secret], 1_795_000_000);

    expect(
      verifyWebhook(
        [secret],
        { id: headers['webhook-id'], timestamp: headers['webhook-timestamp'], signature: headers['webhook-signature'] },
        Buffer.from(notificationBody({ ...event, payload: { status: 'failed' } })),
        1_795_000_000,
        300,
      ),
    ).toBeUndefined();
  });

  it('omits the correlation header when the event has none', () => {
    expect(notificationHeaders({ ...event, correlationId: null }, '{}', [generateWebhookSecret()], 1)).not.toHaveProperty('X-Correlation-Id');
  });
});
