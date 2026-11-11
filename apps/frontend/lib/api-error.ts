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
