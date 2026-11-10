import { backoffMs } from '../src/engine/job-queue.service';

describe('backoffMs', () => {
  it('grows exponentially with the attempt number', () => {
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
    expect(backoffMs(3)).toBe(8000);
  });

  it.todo('re-queues a job whose worker died while holding the lease');
});
