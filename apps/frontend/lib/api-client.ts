import { ApiError, errorFrom, networkFailure, UNEXPECTED_RESPONSE } from './api-error';

export interface ApiResult<T> {
  data: T;
  headers: Headers;
}

export interface ApiRequestInit {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export async function apiRequest<T>(path: string, init: ApiRequestInit = {}): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`/api/proxy${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
      cache: 'no-store',
    });
  } catch (error) {
    throw networkFailure(error);
  }
  if (!res.ok) throw await errorFrom(res);
  if (res.status === 204) return { data: undefined as T, headers: res.headers };
  try {
    return { data: (await res.json()) as T, headers: res.headers };
  } catch (error) {
    throw error instanceof SyntaxError ? new ApiError(res.status, [UNEXPECTED_RESPONSE]) : networkFailure(error);
  }
}
