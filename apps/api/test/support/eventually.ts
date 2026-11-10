export interface EventuallyOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export async function eventually<T>(
  assertion: () => T | Promise<T>,
  { timeoutMs = 15_000, intervalMs = 100 }: EventuallyOptions = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      return await assertion();
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function consistently(
  assertion: () => unknown | Promise<unknown>,
  { timeoutMs = 2_000, intervalMs = 100 }: EventuallyOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await assertion();
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  await assertion();
}
