import { Injectable } from '@nestjs/common';
import { TenantDb } from '../db/tenant-db.service';
import { Job } from '../entities';

const LEASE_SECONDS = 60;

export function backoffMs(attempt: number): number {
  return Math.pow(2, attempt) * 1000;
}

@Injectable()
export class JobQueueService {
  constructor(private readonly db: TenantDb) {}

  async claimNext(workerId: string): Promise<Job | null> {
    const next = await this.db.nextReadyJob();
    if (!next) return null;

    return this.db.run(next.tenantId, async (em) => {
      await em.query(
        `UPDATE jobs
            SET status = 'running', "lockedBy" = $1,
                "lockedUntil" = now() + make_interval(secs => $2),
                attempts = attempts + 1
          WHERE id = $3`,
        [workerId, LEASE_SECONDS, next.id],
      );
      const [job] = await em.query(`SELECT * FROM jobs WHERE id = $1`, [next.id]);
      return job as Job;
    });
  }

  async complete(job: Job): Promise<void> {
    await this.db.run(job.tenantId, (em) =>
      em.query(`UPDATE jobs SET status = 'done', "lockedBy" = NULL, "lockedUntil" = NULL WHERE id = $1`, [job.id]),
    );
  }

  async fail(job: Job, error: string, retryable: boolean): Promise<boolean> {
    if (retryable && job.attempts < job.maxAttempts) {
      await this.db.run(job.tenantId, (em) =>
        em.query(
          `UPDATE jobs
              SET status = 'queued', "lockedBy" = NULL, "lockedUntil" = NULL, "lastError" = $2,
                  "runAt" = now() + make_interval(secs => $3)
            WHERE id = $1`,
          [job.id, error, backoffMs(job.attempts) / 1000],
        ),
      );
      return true;
    }
    await this.db.run(job.tenantId, (em) =>
      em.query(
        `UPDATE jobs SET status = 'failed', "lockedBy" = NULL, "lockedUntil" = NULL, "lastError" = $2 WHERE id = $1`,
        [job.id, error],
      ),
    );
    return false;
  }
}
