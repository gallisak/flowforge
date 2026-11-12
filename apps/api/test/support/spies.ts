import { eventually } from './eventually';

export async function settledCalls(spy: jest.SpyInstance): Promise<void> {
  await eventually(() => expect(spy).toHaveBeenCalled(), { timeoutMs: 15_000 });
  await Promise.allSettled(spy.mock.results.map((result) => result.value));
}
