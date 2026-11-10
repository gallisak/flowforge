import { LookupAddress } from 'dns';
import {
  DestinationNotAllowedError,
  findDestinationError,
  guardedLookup,
  InvalidRequestUrlError,
  isPublicAddress,
  Resolver,
  SafeHttpClient,
  TooManyRedirectsError,
} from '../src/engine/http/safe-http';
import { Receiver, startReceiver } from './support/receiver';

const v4 = (address: string): LookupAddress => ({ address, family: 4 });
const v6 = (address: string): LookupAddress => ({ address, family: 6 });

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '192.0.2.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd00:ec2::254',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.1',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2001:db8::1',
    'ff02::1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('guardedLookup', () => {
  function lookupWith(resolve: Resolver, options: { all?: boolean; family?: number } = {}) {
    return new Promise<{ error: Error | null; address: unknown; family?: number }>((done) =>
      guardedLookup(resolve)('example.test', options, (error, address, family) => done({ error, address, family })),
    );
  }

  it('rejects a name when any of its addresses is internal', async () => {
    const { error } = await lookupWith(async () => [v4('93.184.216.34'), v4('127.0.0.1')], { all: true });
    expect(error).toBeInstanceOf(DestinationNotAllowedError);
  });

  it('rejects a name resolving to the cloud metadata address', async () => {
    const { error } = await lookupWith(async () => [v4('169.254.169.254')]);
    expect(error).toBeInstanceOf(DestinationNotAllowedError);
  });

  it('rejects an internal address even when the requested family would hide it', async () => {
    const { error } = await lookupWith(async () => [v4('93.184.216.34'), v6('::1')], { family: 4 });
    expect(error).toBeInstanceOf(DestinationNotAllowedError);
  });

  it('hands the connection exactly the addresses it checked, resolving once', async () => {
    const resolve = jest.fn(async () => [v4('93.184.216.34'), v6('2606:4700:4700::1111')]);
    expect(await lookupWith(resolve, { all: true })).toEqual({
      error: null,
      address: [v4('93.184.216.34'), v6('2606:4700:4700::1111')],
      family: undefined,
    });
    expect(await lookupWith(resolve)).toEqual({ error: null, address: '93.184.216.34', family: 4 });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('passes resolver failures through', async () => {
    const { error } = await lookupWith(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    });
    expect(error).toMatchObject({ code: 'ENOTFOUND' });
  });
});

describe('SafeHttpClient', () => {
  let allowed: Receiver;
  let other: Receiver;
  let blocked: Receiver;
  let client: SafeHttpClient;
  const resolve = jest.fn<Promise<LookupAddress[]>, [string]>();
  const hostOf = (receiver: Receiver) => new URL(receiver.url).host;

  beforeAll(async () => {
    blocked = await startReceiver();
    other = await startReceiver();
    allowed = await startReceiver((req, res) => {
      const [, kind, target] = req.path.split('/');
      if (kind === 'to') res.writeHead(Number(target), { location: `${other.url}/landed` }).end();
      else if (kind === 'same') res.writeHead(302, { location: '/landed' }).end();
      else if (kind === 'loop') res.writeHead(302, { location: '/loop' }).end();
      else if (kind === 'blocked') res.writeHead(307, { location: `${blocked.url}/landed` }).end();
      else if (kind === 'hang') return;
      else res.writeHead(200).end(kind);
    });
    client = new SafeHttpClient({
      allowlist: [hostOf(allowed), hostOf(other)],
      timeoutMs: 1_000,
      maxRedirects: 3,
      resolve,
    });
  });

  afterAll(async () => {
    await client.close();
    await Promise.all([allowed.close(), other.close(), blocked.close()]);
  });

  beforeEach(() => resolve.mockReset());

  const send = (url: string, init: Partial<Parameters<SafeHttpClient['request']>[1]> = {}) =>
    client.request(url, { method: 'GET', headers: {}, ...init });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f.0.0.1/',
  ])('blocks the address literal %s without connecting', async (url) => {
    await expect(send(url)).rejects.toBeInstanceOf(DestinationNotAllowedError);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('blocks a name that resolves to an internal address', async () => {
    resolve.mockResolvedValue([v4('169.254.169.254')]);
    const error = await send('http://metadata.google.internal/computeMetadata/v1/').catch((e: unknown) => e);
    expect(findDestinationError(error)).toBeInstanceOf(DestinationNotAllowedError);
    expect(resolve).toHaveBeenCalledWith('metadata.google.internal');
  });

  it('blocks a name that resolves to both public and internal addresses', async () => {
    resolve.mockResolvedValue([v4('93.184.216.34'), v4('127.0.0.1')]);
    const error = await send('http://rebind.example/').catch((e: unknown) => e);
    expect(findDestinationError(error)).toBeInstanceOf(DestinationNotAllowedError);
  });

  it('checks every redirect target', async () => {
    await expect(send(`${allowed.url}/blocked`)).rejects.toBeInstanceOf(DestinationNotAllowedError);
    expect(blocked.requests).toHaveLength(0);
  });

  it('stops after the redirect limit', async () => {
    await expect(send(`${allowed.url}/loop`)).rejects.toBeInstanceOf(TooManyRedirectsError);
  });

  it('drops credentials when a redirect leaves the origin and keeps other headers', async () => {
    await send(`${allowed.url}/to/307`, {
      method: 'POST',
      body: '{"a":1}',
      headers: { authorization: 'Bearer secret', cookie: 'session=1', 'idempotency-key': 'k', 'content-type': 'application/json' },
    });
    const landed = other.requests[other.requests.length - 1];
    expect(landed).toMatchObject({ method: 'POST', body: '{"a":1}' });
    expect(landed.headers).toMatchObject({ 'idempotency-key': 'k', 'content-type': 'application/json' });
    expect(landed.headers.authorization).toBeUndefined();
    expect(landed.headers.cookie).toBeUndefined();
  });

  it('keeps credentials on a same-origin redirect', async () => {
    await send(`${allowed.url}/same`, { headers: { authorization: 'Bearer secret' } });
    const landed = allowed.requests[allowed.requests.length - 1];
    expect(landed).toMatchObject({ path: '/landed', headers: expect.objectContaining({ authorization: 'Bearer secret' }) });
  });

  it('turns a POST into a GET without a body after a 303', async () => {
    await send(`${allowed.url}/to/303`, { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' } });
    const landed = other.requests[other.requests.length - 1];
    expect(landed).toMatchObject({ method: 'GET', body: '' });
    expect(landed.headers['content-type']).toBeUndefined();
  });

  it.each(['ftp://example.com/file', 'file:///etc/passwd', 'http://user:pass@example.com/', 'not a url'])(
    'rejects the url %s',
    async (url) => {
      await expect(send(url)).rejects.toBeInstanceOf(InvalidRequestUrlError);
    },
  );

  it('gives up when the server does not answer in time', async () => {
    const started = Date.now();
    await expect(send(`${allowed.url}/hang`)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('returns status and body of an allowed destination', async () => {
    await expect(send(`${allowed.url}/hello`)).resolves.toEqual({ status: 200, body: 'hello' });
  });
});
