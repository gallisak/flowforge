import { Injectable } from '@nestjs/common';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { ReapedJob, TenantDb } from '../db/tenant-db.service';
import { Execution, Job } from '../entities';

export interface RetryPolicy {
  baseMs: number;
  capMs: number;
}

export function retryCeilingMs(attempt: number, policy: RetryPolicy): number {
  return Math.min(policy.capMs, policy.baseMs * 2 ** attempt);
}

export function retryDelayMs(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const ceiling = retryCeilingMs(attempt, policy);
  const floor = Math.min(policy.baseMs, ceiling);
  return Math.round(floor + random() * (ceiling - floor));
}

export function backoffMs(attempt: number): number {
  return retryCeilingMs(attempt, { baseMs: 1000, capMs: Number.POSITIVE_INFINITY });
}

export type ExecutionUpdate = QueryDeepPartialEntity<Execution>;
export type FailOutcome = 'retry' | 'failed' | 'dead' | 'lost';

const intervalFromNow = (seconds: number) => () => `now() + make_interval(secs => ${Number(seconds)})`;

@Injectable()
export class JobQueueService {
  constructor(private readonly db: TenantDb) {}

  claimNext(workerId: string, leaseSeconds: number): Promise<Job | null> {
    return this.db.claimJob(workerId, leaseSeconds);
  }

  async extendLease(job: Job, workerId: string, leaseSeconds: number): Promise<boolean> {
    const result = await this.db.run(job.tenantId, (em) =>
      em.update(Job, this.ownedBy(job, workerId), { lockedUntil: intervalFromNow(leaseSeconds) }),
    );
    return result.affected === 1;
  }

  complete(job: Job, workerId: string, execution: ExecutionUpdate): Promise<boolean> {
    return this.db.run(job.tenantId, async (em) => {
      const result = await em.update(Job, this.ownedBy(job, workerId), {
        status: 'done',
        lockedBy: null,
        lockedUntil: null,
      });
      if (result.affected !== 1) return false;
      await em.update(Execution, job.executionId, execution);
      return true;
    });
  }

  fail(job: Job, workerId: string, error: string, retryable: boolean, policy: RetryPolicy): Promise<FailOutcome> {
    const outcome: Exclude<FailOutcome, 'lost'> = !retryable ? 'failed' : job.attempts < job.maxAttempts ? 'retry' : 'dead';
    return this.db.run(job.tenantId, async (em) => {
      const released = { lockedBy: null, lockedUntil: null, lastError: error };
      const result = await em.update(
        Job,
        this.ownedBy(job, workerId),
        outcome === 'retry'
          ? { ...released, status: 'queued', runAt: intervalFromNow(retryDelayMs(job.attempts, policy) / 1000) }
          : { ...released, status: outcome },
      );
      if (result.affected !== 1) return 'lost';
      if (outcome === 'failed') {
        await em.update(Execution, job.executionId, { status: 'failed', error, finishedAt: new Date() });
      }
      if (outcome === 'dead') {
        await em.update(Execution, job.executionId, {
          status: 'failed',
          error: `${error} (gave up after ${job.attempts} attempts)`,
          finishedAt: new Date(),
        });
      }
      return outcome;
    });
  }

  release(job: Job, workerId: string): Promise<boolean> {
    return this.db.run(job.tenantId, async (em) => {
      const result = await em.update(Job, this.ownedBy(job, workerId), {
        status: 'queued',
        lockedBy: null,
        lockedUntil: null,
        attempts: () => '"attempts" - 1',
        runAt: () => 'now()',
      });
      if (result.affected !== 1) return false;
      await em.update(Execution, job.executionId, { status: 'pending' });
      return true;
    });
  }

  reapExpired(): Promise<ReapedJob[]> {
    return this.db.reapExpiredJobs();
  }

  private ownedBy(job: Job, workerId: string) {
    return { id: job.id, lockedBy: workerId, attempts: job.attempts, status: 'running' as const };
  }
}
