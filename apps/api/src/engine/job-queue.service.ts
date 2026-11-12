import { Injectable } from '@nestjs/common';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { ReapedJob, TenantDb } from '../db/tenant-db.service';
import { EntityManager } from 'typeorm';
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

export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`lease on job ${jobId} was lost`);
  }
}

export type ExecutionUpdate = QueryDeepPartialEntity<Execution>;
export type FailOutcome = 'retry' | 'failed' | 'dead' | 'lost';

async function recordExecutionEvent(em: EntityManager, executionId: string): Promise<void> {
  await em.query('SELECT record_execution_event($1)', [executionId]);
}

async function failInterruptedStep(em: EntityManager, executionId: string, error: string, alsoSleeping = false): Promise<void> {
  const statuses = alsoSleeping ? ['running', 'waiting'] : ['running'];
  await em.query(
    `UPDATE step_runs SET "status" = 'failed', "error" = $2, "finishedAt" = now() WHERE "executionId" = $1 AND "status" = ANY ($3)`,
    [executionId, error, statuses],
  );
}

export const SHUTDOWN_INTERRUPTION = 'interrupted because the worker is shutting down';

const intervalFromNow = (seconds: number) => () => `now() + make_interval(secs => ${Number(seconds)})`;

@Injectable()
export class JobQueueService {
  constructor(private readonly db: TenantDb) {}

  claimNext(workerId: string, leaseSeconds: number, defaultMaxRunning: number): Promise<Job | null> {
    return this.db.claimJob(workerId, leaseSeconds, defaultMaxRunning);
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
      await em.update(Execution, job.executionId, { ...execution, error: null });
      await recordExecutionEvent(em, job.executionId);
      return true;
    });
  }

  fail(job: Job, workerId: string, error: string, retryable: boolean, policy: RetryPolicy): Promise<FailOutcome> {
    const stepAttempts = job.attempts - (job.attemptsAtProgress ?? 0);
    const outcome: Exclude<FailOutcome, 'lost'> = !retryable ? 'failed' : stepAttempts < job.maxAttempts ? 'retry' : 'dead';
    return this.db.run(job.tenantId, async (em) => {
      const released = { lockedBy: null, lockedUntil: null, lastError: error };
      const result = await em.update(
        Job,
        this.ownedBy(job, workerId),
        outcome === 'retry'
          ? { ...released, status: 'queued', runAt: intervalFromNow(retryDelayMs(stepAttempts, policy) / 1000) }
          : { ...released, status: outcome },
      );
      if (result.affected !== 1) return 'lost';
      await failInterruptedStep(em, job.executionId, error, outcome !== 'retry');
      if (outcome === 'retry') {
        await em.update(Execution, job.executionId, { status: 'pending', error });
      }
      if (outcome === 'failed') {
        await em.update(Execution, job.executionId, { status: 'failed', error, finishedAt: () => 'now()' });
      }
      if (outcome === 'dead') {
        await em.update(Execution, job.executionId, {
          status: 'failed',
          error: `${error} (gave up after ${stepAttempts} attempts)`,
          finishedAt: () => 'now()',
        });
      }
      if (outcome !== 'retry') await recordExecutionEvent(em, job.executionId);
      return outcome;
    });
  }

  markRunning(job: Job, workerId: string): Promise<void> {
    return this.withOwnership(job, workerId, async (em) => {
      await em.query(`UPDATE executions SET "status" = 'running' WHERE id = $1 AND "status" IN ('pending', 'waiting', 'running')`, [
        job.executionId,
      ]);
    });
  }

  withOwnership<T>(job: Job, workerId: string, work: (em: EntityManager) => Promise<T>): Promise<T> {
    return this.db.run(job.tenantId, async (em) => {
      const owned: unknown[] = await em.query(
        `SELECT 1 FROM jobs WHERE id = $1 AND "lockedBy" = $2 AND attempts = $3 AND status = 'running' FOR UPDATE`,
        [job.id, workerId, job.attempts],
      );
      if (owned.length !== 1) throw new LeaseLostError(job.id);
      return work(em);
    });
  }

  startStep(job: Job, workerId: string, stepIndex: number, stepId: string, idempotencyKey: string | null): Promise<string> {
    return this.withOwnership(job, workerId, async (em) => {
      const [row]: Array<{ id: string }> = await em.query(
        `INSERT INTO step_runs ("tenantId", "executionId", "stepIndex", "stepId", "status", "attempts", "startedAt", "idempotencyKey")
         VALUES ($1, $2, $3, $4, 'running', 1, now(), $5)
         ON CONFLICT ("executionId", "stepIndex") DO UPDATE
            SET "status" = 'running', "attempts" = step_runs."attempts" + 1, "startedAt" = now(),
                "error" = NULL, "finishedAt" = NULL
         RETURNING id`,
        [job.tenantId, job.executionId, stepIndex, stepId, idempotencyKey],
      );
      return row.id;
    });
  }

  finishStep(job: Job, workerId: string, stepRunId: string, output: unknown): Promise<unknown> {
    return this.withOwnership(job, workerId, async (em) => {
      const [[row]]: [Array<{ output: unknown }>, number] = await em.query(
        `UPDATE step_runs SET "status" = 'succeeded', "output" = $2::jsonb, "error" = NULL, "finishedAt" = now()
          WHERE id = $1
          RETURNING "output"`,
        [stepRunId, output === undefined ? null : JSON.stringify(output)],
      );
      await this.recordProgress(em, job);
      return row.output;
    });
  }

  sleep(job: Job, workerId: string, stepIndex: number, stepId: string, ms: number): Promise<void> {
    return this.withOwnership(job, workerId, async (em) => {
      await em.query(
        `INSERT INTO step_runs ("tenantId", "executionId", "stepIndex", "stepId", "status", "attempts", "startedAt", "wakeAt")
         VALUES ($1, $2, $3, $4, 'waiting', 1, now(), now() + make_interval(secs => $5))
         ON CONFLICT ("executionId", "stepIndex") DO UPDATE
            SET "status" = 'waiting', "attempts" = step_runs."attempts" + 1, "startedAt" = now(),
                "wakeAt" = EXCLUDED."wakeAt", "error" = NULL, "finishedAt" = NULL`,
        [job.tenantId, job.executionId, stepIndex, stepId, ms / 1000],
      );
      await this.parkUntilWakeUp(em, job, stepIndex);
    });
  }

  wakeUp(job: Job, workerId: string, stepIndex: number, output: unknown): Promise<'resumed' | 'sleeping'> {
    return this.withOwnership(job, workerId, async (em) => {
      const [due]: [unknown[], number] = await em.query(
        `UPDATE step_runs SET "status" = 'succeeded', "output" = $3::jsonb, "finishedAt" = now()
          WHERE "executionId" = $1 AND "stepIndex" = $2 AND "status" = 'waiting' AND "wakeAt" <= now()
          RETURNING id`,
        [job.executionId, stepIndex, JSON.stringify(output)],
      );
      if (due.length === 1) {
        await this.recordProgress(em, job);
        return 'resumed';
      }
      await this.parkUntilWakeUp(em, job, stepIndex);
      return 'sleeping';
    });
  }

  private async recordProgress(em: EntityManager, job: Job): Promise<void> {
    await em.query(`UPDATE jobs SET "attemptsAtProgress" = "attempts" - 1 WHERE id = $1`, [job.id]);
    job.attemptsAtProgress = job.attempts - 1;
  }

  private async parkUntilWakeUp(em: EntityManager, job: Job, stepIndex: number): Promise<void> {
    await em.query(
      `UPDATE jobs SET "status" = 'queued', "lockedBy" = NULL, "lockedUntil" = NULL,
              "attempts" = "attempts" - 1,
              "runAt" = (SELECT s."wakeAt" FROM step_runs s WHERE s."executionId" = $2 AND s."stepIndex" = $3)
        WHERE id = $1`,
      [job.id, job.executionId, stepIndex],
    );
    await em.update(Execution, job.executionId, { status: 'waiting' });
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
      await failInterruptedStep(em, job.executionId, SHUTDOWN_INTERRUPTION);
      await em.update(Execution, job.executionId, { status: 'pending' });
      return true;
    });
  }

  reapExpired(policy: RetryPolicy): Promise<ReapedJob[]> {
    return this.db.reapExpiredJobs(policy.baseMs, policy.capMs);
  }

  private ownedBy(job: Job, workerId: string) {
    return { id: job.id, lockedBy: workerId, attempts: job.attempts, status: 'running' as const };
  }
}
