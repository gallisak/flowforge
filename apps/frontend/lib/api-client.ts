import { errorFrom } from './api-error';

export interface ApiResult<T> {
  data: T;
  headers: Headers;
}

export async function apiRequest<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<ApiResult<T>> {
  const res = await fetch(`/api/proxy${path}`, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
    cache: 'no-store',
  });
  if (!res.ok) throw await errorFrom(res);
  const data = (res.status === 204 ? undefined : await res.json()) as T;
  return { data, headers: res.headers };
}
