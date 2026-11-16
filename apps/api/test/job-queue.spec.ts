import { retryCeilingMs } from '../src/engine/job-queue.service';

describe('retryCeilingMs', () => {
  it('grows exponentially with the attempt number', () => {
    const uncapped = { baseMs: 1000, capMs: Number.POSITIVE_INFINITY };
    expect(retryCeilingMs(1, uncapped)).toBe(2000);
    expect(retryCeilingMs(2, uncapped)).toBe(4000);
    expect(retryCeilingMs(3, uncapped)).toBe(8000);
  });
});
