import { verifyWebhook, webhookSignature } from '../src/webhooks/signature';

describe('verifyWebhook', () => {
  const secret = 'current-secret';
  const id = 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W';
  const now = 1_700_000_000;
  const timestamp = String(now);
  const payload = Buffer.from('{"event":"order.paid"}');
  const v1 = (key: string, msgId = id, ts = timestamp, body = payload) => `v1,${webhookSignature(key, msgId, ts, body).toString('base64')}`;
  const verify = (headers: { id?: string; timestamp?: string; signature?: string }, secrets = [secret], body = payload, at = now) =>
    verifyWebhook(secrets, headers, body, at, 300);

  it('accepts a valid signature and returns the message id', () => {
    expect(verify({ id, timestamp, signature: v1(secret) })).toBe(id);
  });

  it('rejects a modified body', () => {
    expect(verify({ id, timestamp, signature: v1(secret) }, [secret], Buffer.from('{"event":"order.refunded"}'))).toBeUndefined();
  });

  it('rejects a signature made for another message id', () => {
    expect(verify({ id: 'msg_other', timestamp, signature: v1(secret) })).toBeUndefined();
  });

  it('rejects a signature made for another timestamp', () => {
    expect(verify({ id, timestamp: String(now - 1), signature: v1(secret) })).toBeUndefined();
  });

  it('accepts a header with several signatures when one of them matches', () => {
    expect(verify({ id, timestamp, signature: `${v1('old-secret')} ${v1(secret)}` })).toBe(id);
  });

  it('accepts any of several active secrets', () => {
    expect(verify({ id, timestamp, signature: v1('next-secret') }, [secret, 'next-secret'])).toBe(id);
  });

  it.each([
    ['an unknown version', `v2,${webhookSignature(secret, id, timestamp, payload).toString('base64')}`],
    ['a missing version', webhookSignature(secret, id, timestamp, payload).toString('base64')],
    ['invalid base64', 'v1,%%%not-base64%%%'],
    ['a truncated signature', v1(secret).slice(0, 20)],
    ['an empty header', ''],
  ])('rejects %s', (_case, signature) => {
    expect(verify({ id, timestamp, signature })).toBeUndefined();
  });

  it.each([
    ['missing id', { timestamp, signature: v1(secret) }],
    ['missing timestamp', { id, signature: v1(secret) }],
    ['missing signature', { id, timestamp }],
    ['non-numeric timestamp', { id, timestamp: '17e8', signature: v1(secret, id, '17e8') }],
    ['id with spaces', { id: 'msg 1', timestamp, signature: v1(secret, 'msg 1') }],
  ])('rejects a delivery with a %s', (_case, headers) => {
    expect(verify(headers)).toBeUndefined();
  });

  it('accepts timestamps at the edge of the tolerance and rejects them just beyond', () => {
    expect(verify({ id, timestamp, signature: v1(secret) }, [secret], payload, now + 300)).toBe(id);
    expect(verify({ id, timestamp, signature: v1(secret) }, [secret], payload, now - 300)).toBe(id);
    expect(verify({ id, timestamp, signature: v1(secret) }, [secret], payload, now + 301)).toBeUndefined();
    expect(verify({ id, timestamp, signature: v1(secret) }, [secret], payload, now - 301)).toBeUndefined();
  });

  it('rejects everything when there is no active secret', () => {
    expect(verify({ id, timestamp, signature: v1(secret) }, [])).toBeUndefined();
  });
});
