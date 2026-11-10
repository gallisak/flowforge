import { LookupAddress, promises as dns } from 'dns';
import { isIP } from 'net';
import ipaddr from 'ipaddr.js';
import { Agent, Dispatcher, request } from 'undici';

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export interface SafeHttpOptions {
  allowlist: readonly string[];
  timeoutMs: number;
  maxRedirects: number;
  maxResponseBytes: number;
  connectTimeoutMs?: number;
  resolve?: Resolver;
}

export interface SafeHttpRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface SafeHttpResponse {
  status: number;
  body: string;
}

export class DestinationNotAllowedError extends Error {
  constructor(readonly hostname: string) {
    super(`http destination is not allowed: ${hostname}`);
  }
}

export class InvalidRequestUrlError extends Error {}

export class TooManyRedirectsError extends Error {}

export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`http response body exceeds ${limit} bytes`);
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);
const BODY_HEADERS = new Set(['content-type', 'content-length', 'content-encoding', 'transfer-encoding']);
const GLOBAL_UNICAST_V6 = ipaddr.parseCIDR('2000::/3');
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.process(address);
  if (parsed.range() !== 'unicast') return false;
  return parsed.kind() === 'ipv4' || parsed.match(GLOBAL_UNICAST_V6);
}

const defaultResolver: Resolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

export function guardedLookup(resolve: Resolver) {
  return (hostname: string, options: { family?: number | string; all?: boolean }, callback: LookupCallback): void => {
    resolve(hostname).then(
      (resolved) => {
        const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : Number(options.family ?? 0);
        const addresses = family ? resolved.filter((a) => a.family === family) : resolved;
        if (addresses.length === 0) {
          callback(Object.assign(new Error(`could not resolve ${hostname}`), { code: 'ENOTFOUND' }), []);
          return;
        }
        if (resolved.some((a) => !isPublicAddress(a.address))) {
          callback(new DestinationNotAllowedError(hostname), []);
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
      (error: NodeJS.ErrnoException) => callback(error, []),
    );
  };
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

function defaultPort(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

export function findDestinationError(error: unknown): DestinationNotAllowedError | undefined {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (current instanceof DestinationNotAllowedError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export class SafeHttpClient {
  private readonly allowlist: Set<string>;
  private readonly guarded: Agent;
  private readonly trusted: Agent;

  constructor(private readonly options: SafeHttpOptions) {
    this.allowlist = new Set(options.allowlist.map(normalizeHost));
    const timeouts = { headersTimeout: options.timeoutMs, bodyTimeout: options.timeoutMs };
    const connectTimeout = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.guarded = new Agent({
      ...timeouts,
      connect: { timeout: connectTimeout, lookup: guardedLookup(options.resolve ?? defaultResolver) },
    });
    this.trusted = new Agent({ ...timeouts, connect: { timeout: connectTimeout } });
  }

  async request(rawUrl: string, init: SafeHttpRequest): Promise<SafeHttpResponse> {
    const deadline = AbortSignal.timeout(this.options.timeoutMs);
    const signal = init.signal ? AbortSignal.any([deadline, init.signal]) : deadline;
    let url = this.parse(rawUrl);
    let method = init.method.toUpperCase();
    let headers = { ...init.headers };
    let body = init.body;

    for (let hop = 0; ; hop++) {
      const response = await request(url, { method, headers, body, signal, dispatcher: this.dispatcherFor(url) });
      const location = response.headers.location;
      if (!REDIRECT_STATUSES.has(response.statusCode) || typeof location !== 'string') {
        return { status: response.statusCode, body: await this.readBody(response) };
      }
      await response.body.dump();
      if (hop >= this.options.maxRedirects) throw new TooManyRedirectsError(`more than ${this.options.maxRedirects} redirects`);
      const next = this.parse(new URL(location, url).toString());
      if (next.origin !== url.origin) {
        headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())));
      }
      if (response.statusCode === 303 ? method !== 'HEAD' : response.statusCode <= 302 && method === 'POST') {
        method = 'GET';
        body = undefined;
        headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !BODY_HEADERS.has(name.toLowerCase())));
      }
      url = next;
    }
  }

  private async readBody(response: Dispatcher.ResponseData): Promise<string> {
    const limit = this.options.maxResponseBytes;
    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      response.body.destroy();
      throw new ResponseTooLargeError(limit);
    }
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += (chunk as Buffer).length;
      if (received > limit) {
        response.body.destroy();
        throw new ResponseTooLargeError(limit);
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async close(): Promise<void> {
    await Promise.all([this.guarded.destroy(), this.trusted.destroy()]);
  }

  private parse(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new InvalidRequestUrlError('http url is invalid');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new InvalidRequestUrlError('http url must use http or https');
    if (url.username || url.password) throw new InvalidRequestUrlError('http url must not contain credentials');
    if (!this.isAllowlisted(url)) {
      const literal = url.hostname.replace(/^\[|\]$/g, '');
      if (isIP(literal) && !isPublicAddress(literal)) throw new DestinationNotAllowedError(url.hostname);
    }
    return url;
  }

  private isAllowlisted(url: URL): boolean {
    const host = normalizeHost(url.hostname);
    return this.allowlist.has(host) || this.allowlist.has(`${host}:${defaultPort(url)}`);
  }

  private dispatcherFor(url: URL): Dispatcher {
    return this.isAllowlisted(url) ? this.trusted : this.guarded;
  }
}
