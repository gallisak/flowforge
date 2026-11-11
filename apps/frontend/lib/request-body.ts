export const MAX_PROXY_BODY_BYTES = 1_048_576;
export const MAX_CONNECT_BODY_BYTES = 4_096;

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body must be at most ${maxBytes} bytes`);
  }
}

export async function readLimitedText(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new BodyTooLargeError(maxBytes);
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
