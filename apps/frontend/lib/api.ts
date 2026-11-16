import { cookies, headers } from 'next/headers';
import { ApiError, errorFrom } from './api-error';
import { clientAddressHeaders } from './client-address';

export const API_URL = process.env.API_URL ?? 'http://localhost:3000';
export const API_KEY_COOKIE = 'ff_api_key';
export const API_TIMEOUT_MS = 30_000;

export const UNEXPECTED_REDIRECT = 'The API answered with a redirect';

export function isRedirect(res: Response): boolean {
  return res.status >= 300 && res.status < 400;
}

export function timeoutError(): Error {
  const error = new Error('The API did not answer in time');
  error.name = 'TimeoutError';
  return error;
}

export function upstreamSignal(client: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
  deadline.unref?.();
  const clientLeft = () => {
    clearTimeout(deadline);
    controller.abort(client?.reason);
  };
  if (client?.aborted) clientLeft();
  else client?.addEventListener('abort', clientLeft, { once: true });
  return controller.signal;
}

export function unreachable(error: unknown): { status: number; message: string } {
  return (error as Error | null)?.name === 'TimeoutError'
    ? { status: 504, message: 'The API did not answer in time' }
    : { status: 502, message: 'The API is not reachable' };
}

export async function hasApiKey(): Promise<boolean> {
  return Boolean((await cookies()).get(API_KEY_COOKIE)?.value);
}

async function apiResponse(path: string): Promise<Response> {
  const key = (await cookies()).get(API_KEY_COOKIE)?.value;
  if (!key) throw new ApiError(401, ['Connect with a valid API key first']);
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'x-api-key': key, ...clientAddressHeaders(await headers()) },
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (isRedirect(res)) throw new ApiError(502, [UNEXPECTED_REDIRECT]);
  if (!res.ok) throw await errorFrom(res);
  return res;
}

export async function apiFetch<T>(path: string): Promise<T> {
  return (await apiResponse(path)).json() as Promise<T>;
}

export async function apiFetchPage<T>(path: string): Promise<{ items: T[]; nextCursor: string | null }> {
  const res = await apiResponse(path);
  return { items: (await res.json()) as T[], nextCursor: res.headers.get('x-next-cursor') };
}
