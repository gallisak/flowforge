import { backoffMs, retryCeilingMs, retryDelayMs } from '../src/engine/job-queue.service';
import { isRetryableStatus } from '../src/engine/step-executor';

const policy = { baseMs: 1_000, capMs: 30_000 };

describe('retryCeilingMs', () => {
  it('doubles with every attempt', () => {
    expect([1, 2, 3, 4].map((attempt) => retryCeilingMs(attempt, policy))).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  it('never exceeds the cap', () => {
    expect(retryCeilingMs(5, policy)).toBe(30_000);
    expect(retryCeilingMs(50, policy)).toBe(30_000);
  });

  it('matches the uncapped backoffMs used by the starter', () => {
    expect([1, 2, 3].map((attempt) => retryCeilingMs(attempt, { baseMs: 1_000, capMs: Infinity }))).toEqual(
      [1, 2, 3].map(backoffMs),
    );
  });
});

describe('retryDelayMs', () => {
  it('waits at least the base delay', () => {
    expect(retryDelayMs(3, policy, () => 0)).toBe(1_000);
  });

  it('waits at most the ceiling of the attempt', () => {
    expect(retryDelayMs(3, policy, () => 0.999_999)).toBe(8_000);
  });

  it('stays within [base, cap] for any attempt', () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      const delay = retryDelayMs(attempt, policy);
      expect(delay).toBeGreaterThanOrEqual(policy.baseMs);
      expect(delay).toBeLessThanOrEqual(policy.capMs);
    }
  });

  it('spreads retries of jobs that failed at the same time', () => {
    const delays = new Set(Array.from({ length: 50 }, () => retryDelayMs(4, policy)));
    expect(delays.size).toBeGreaterThan(40);
  });

  it('respects a cap smaller than the first ceiling', () => {
    expect(retryDelayMs(1, { baseMs: 1_000, capMs: 500 }, () => 0.5)).toBe(500);
  });
});

describe('isRetryableStatus', () => {
  it.each([500, 502, 503, 504, 408, 425, 429])('retries %i', (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 410, 422])('does not retry %i', (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });
});
