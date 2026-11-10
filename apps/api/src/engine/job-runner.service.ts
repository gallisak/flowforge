import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { WORKER_CONFIG, WorkerConfig } from '../config/config';
import { TenantDb } from '../db/tenant-db.service';
import { Execution, Job, StepRun, Workflow } from '../entities';
import { JobQueueService } from './job-queue.service';
import { StepError, StepExecutor } from './step-executor';
import { StepContext } from './template';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`lease on job ${jobId} was lost`);
  }
}

@Injectable()
export class JobRunnerService implements OnApplicationShutdown {
  private readonly logger = new Logger(JobRunnerService.name);
  readonly workerId = `worker-${randomUUID().slice(0, 8)}`;
  private running = false;
  private reaperTimer?: NodeJS.Timeout;

  constructor(
    private readonly queue: JobQueueService,
    private readonly executor: StepExecutor,
    private readonly db: TenantDb,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  start(concurrency: number): void {
    this.running = true;
    this.logger.log(`${this.workerId} started, concurrency=${concurrency}`);
    this.scheduleReaper();
    for (let i = 0; i < concurrency; i++) void this.loop();
  }

  onApplicationShutdown(): void {
    this.running = false;
    if (this.reaperTimer) clearTimeout(this.reaperTimer);
  }

  private scheduleReaper(): void {
    this.reaperTimer = setTimeout(async () => {
      try {
        const reaped = await this.queue.reapExpired();
        if (reaped.length > 0) this.logger.warn(`recovered ${reaped.length} job(s) with an expired lease`);
      } catch (err) {
        this.logger.error(`reaper error: ${(err as Error).message}`);
      }
      if (this.running) this.scheduleReaper();
    }, this.config.reaperIntervalMs);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const job = await this.queue.claimNext(this.workerId, this.config.leaseSeconds);
        if (!job) {
          await sleep(250);
          continue;
        }
        await this.processWithLease(job);
      } catch (err) {
        this.logger.error(`loop error: ${(err as Error).message}`);
        await sleep(1000);
      }
    }
  }

  private async processWithLease(job: Job): Promise<void> {
    const lease = new AbortController();
    const heartbeat = setInterval(() => {
      this.queue
        .extendLease(job, this.workerId, this.config.leaseSeconds)
        .catch(() => false)
        .then((kept) => {
          if (!kept && !lease.signal.aborted) lease.abort(new LeaseLostError(job.id));
        });
    }, (this.config.leaseSeconds * 1000) / 3);
    try {
      await this.process(job, lease.signal);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async process(job: Job, signal?: AbortSignal): Promise<void> {
    const inTenant = <T>(work: (em: EntityManager) => Promise<T>) => this.db.run(job.tenantId, work);

    const execution = await inTenant((em) => em.findOneOrFail(Execution, { where: { id: job.executionId } }));
    const workflow = await inTenant((em) => em.findOneOrFail(Workflow, { where: { id: execution.workflowId } }));

    await inTenant((em) => em.update(Execution, execution.id, { status: 'running' }));
    const ctx: StepContext = { input: execution.input, steps: {} };

    try {
      for (let i = 0; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];
        const run = await inTenant((em) =>
          em.save(em.create(StepRun, { tenantId: job.tenantId, executionId: execution.id, stepIndex: i, stepId: step.id })),
        );
        try {
          const output = await this.executor.execute(step, ctx, signal);
          ctx.steps[step.id] = output;
          await inTenant((em) => em.update(StepRun, run.id, { status: 'succeeded', output: output as object }));
        } catch (err) {
          await inTenant((em) => em.update(StepRun, run.id, { status: 'failed', error: (err as Error).message }));
          throw err;
        }
      }
      const last = workflow.steps[workflow.steps.length - 1];
      const completed = await this.queue.complete(job, this.workerId, {
        status: 'succeeded',
        output: ctx.steps[last.id] as object,
        finishedAt: new Date(),
      });
      if (!completed) this.logger.warn(`job ${job.id} finished after its lease was lost; result discarded`);
    } catch (err) {
      if (signal?.aborted && signal.reason instanceof LeaseLostError) {
        this.logger.warn(signal.reason.message);
        return;
      }
      const retryable = err instanceof StepError ? err.retryable : true;
      await this.queue.fail(job, this.workerId, (err as Error).message, retryable);
    }
  }
}
