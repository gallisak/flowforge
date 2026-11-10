import { Injectable } from '@nestjs/common';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { ReapedJob, TenantDb } from '../db/tenant-db.service';
import { Execution, Job } from '../entities';

export function backoffMs(attempt: number): number {
  return Math.pow(2, attempt) * 1000;
}

export type ExecutionUpdate = QueryDeepPartialEntity<Execution>;
export type FailOutcome = 'retry' | 'failed' | 'lost';

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

  fail(job: Job, workerId: string, error: string, retryable: boolean): Promise<FailOutcome> {
    const retry = retryable && job.attempts < job.maxAttempts;
    return this.db.run(job.tenantId, async (em) => {
      const result = await em.update(
        Job,
        this.ownedBy(job, workerId),
        retry
          ? {
              status: 'queued',
              lockedBy: null,
              lockedUntil: null,
              lastError: error,
              runAt: intervalFromNow(backoffMs(job.attempts) / 1000),
            }
          : { status: 'failed', lockedBy: null, lockedUntil: null, lastError: error },
      );
      if (result.affected !== 1) return 'lost';
      if (!retry) {
        await em.update(Execution, job.executionId, { status: 'failed', error, finishedAt: new Date() });
      }
      return retry ? 'retry' : 'failed';
    });
  }

  async reapExpired(): Promise<ReapedJob[]> {
    const reaped = await this.db.reapExpiredJobs();
    for (const job of reaped.filter((r) => r.status === 'dead')) {
      await this.db.run(job.tenantId, (em) =>
        em.update(Execution, job.executionId, {
          status: 'failed',
          error: `lease expired ${job.attempts} times: the job was abandoned by its worker on every attempt`,
          finishedAt: new Date(),
        }),
      );
    }
    return reaped;
  }

  private ownedBy(job: Job, workerId: string) {
    return { id: job.id, lockedBy: workerId, attempts: job.attempts, status: 'running' as const };
  }
}
