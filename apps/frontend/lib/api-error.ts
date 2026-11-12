export const NETWORK_FAILURE = 'Could not reach the server. Check your connection and try again.';
export const UNEXPECTED_RESPONSE = 'The server sent an unexpected response';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly messages: string[],
  ) {
    super(messages.join('; ') || `Request failed with status ${status}`);
  }
}

export async function errorFrom(res: Response): Promise<ApiError> {
  let messages: string[] = [];
  try {
    const body = (await res.json()) as { message?: unknown };
    if (Array.isArray(body.message)) messages = body.message.map(String);
    else if (typeof body.message === 'string') messages = [body.message];
  } catch {
    messages = [];
  }
  if (messages.length === 0) messages = [res.status === 401 ? 'Connect with a valid API key first' : `Request failed with status ${res.status}`];
  return new ApiError(res.status, messages);
}

function isAbort(error: unknown): boolean {
  return (error as Error | null)?.name === 'AbortError';
}

export function networkFailure(error: unknown): unknown {
  return isAbort(error) ? error : new ApiError(0, [NETWORK_FAILURE]);
}

export function failureMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return NETWORK_FAILURE;
  return UNEXPECTED_RESPONSE;
}
