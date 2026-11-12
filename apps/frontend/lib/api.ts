import { cookies } from 'next/headers';
import { errorFrom } from './api-error';

export const API_URL = process.env.API_URL ?? 'http://localhost:3000';
export const API_KEY_COOKIE = 'ff_api_key';
export const API_TIMEOUT_MS = 30_000;

export function unreachable(error: unknown): { status: number; message: string } {
  return (error as Error | null)?.name === 'TimeoutError'
    ? { status: 504, message: 'The API did not answer in time' }
    : { status: 502, message: 'The API is not reachable' };
}

export function hasApiKey(): boolean {
  return Boolean(cookies().get(API_KEY_COOKIE)?.value);
}

async function apiResponse(path: string): Promise<Response> {
  const key = cookies().get(API_KEY_COOKIE)?.value ?? '';
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'x-api-key': key },
    cache: 'no-store',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
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
