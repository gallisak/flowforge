import { BeforeApplicationShutdown, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { WORKER_CONFIG, WorkerConfig } from '../config/config';
import { TenantDb } from '../db/tenant-db.service';
import { Execution, Job, StepRun, Workflow, WorkflowVersion } from '../entities';
import { JobQueueService, LeaseLostError } from './job-queue.service';
import { StepError, StepExecutor, stepIdempotencyKey } from './step-executor';
import { StepContext } from './template';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WorkerShutdownError extends Error {
  constructor() {
    super('interrupted because the worker is shutting down');
  }
}

@Injectable()
export class JobRunnerService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(JobRunnerService.name);
  readonly workerId = `worker-${randomUUID().slice(0, 8)}`;
  private running = false;
  private reaperTimer?: NodeJS.Timeout;
  private loops: Promise<void>[] = [];
  private readonly inFlight = new Map<string, AbortController>();

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
    this.loops = Array.from({ length: concurrency }, () => this.loop());
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.reaperTimer) clearTimeout(this.reaperTimer);
    const allLoops = Promise.allSettled(this.loops);
    let graceTimer: NodeJS.Timeout | undefined;
    const graceOver = new Promise<'timeout'>((resolve) => {
      graceTimer = setTimeout(() => resolve('timeout'), this.config.shutdownGraceMs);
    });
    const outcome = await Promise.race([allLoops.then(() => 'drained' as const), graceOver]);
    clearTimeout(graceTimer);
    if (outcome === 'timeout') {
      this.logger.warn(`returning ${this.inFlight.size} unfinished job(s) to the queue`);
      for (const controller of this.inFlight.values()) controller.abort(new WorkerShutdownError());
      await allLoops;
    }
    this.logger.log(`${this.workerId} stopped`);
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
        if (!this.running) {
          await this.queue.release(job, this.workerId);
          return;
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
    this.inFlight.set(job.id, lease);
    const leaseMs = this.config.leaseSeconds * 1000;
    let renewedAt = Date.now();
    const loseLease = () => {
      if (!lease.signal.aborted) lease.abort(new LeaseLostError(job.id));
    };
    const heartbeat = setInterval(() => {
      this.queue.extendLease(job, this.workerId, this.config.leaseSeconds).then(
        (kept) => {
          if (kept) renewedAt = Date.now();
          else loseLease();
        },
        (err: Error) => {
          this.logger.warn(`could not renew lease on job ${job.id}: ${err.message}`);
          if (Date.now() - renewedAt >= leaseMs) loseLease();
        },
      );
    }, leaseMs / 3);
    try {
      await this.process(job, lease.signal);
    } finally {
      clearInterval(heartbeat);
      this.inFlight.delete(job.id);
    }
  }

  async process(job: Job, signal?: AbortSignal): Promise<void> {
    const inTenant = <T>(work: (em: EntityManager) => Promise<T>) => this.db.run(job.tenantId, work);

    try {
      const execution = await inTenant((em) => em.findOne(Execution, { where: { id: job.executionId } }));
      if (!execution) throw new StepError('the execution of this job no longer exists', false);
      const workflowExists = await inTenant((em) => em.exists(Workflow, { where: { id: execution.workflowId } }));
      if (!workflowExists) throw new StepError('the workflow of this execution was deleted', false);
      const snapshot = await inTenant((em) =>
        em.findOne(WorkflowVersion, { where: { workflowId: execution.workflowId, version: execution.workflowVersion } }),
      );
      if (!snapshot) throw new StepError(`version ${execution.workflowVersion} of the workflow is missing`, false);
      const steps = snapshot.steps;

      const checkpoints = await inTenant((em) => em.find(StepRun, { where: { executionId: execution.id } }));
      const succeeded = new Map(checkpoints.filter((r) => r.status === 'succeeded').map((r) => [r.stepIndex, r]));
      const waiting = new Set(checkpoints.filter((r) => r.status === 'waiting').map((r) => r.stepIndex));

      await inTenant((em) => em.update(Execution, execution.id, { status: 'running' }));
      const ctx: StepContext = { input: execution.input, steps: {} };
      steps.forEach((step, i) => {
        const checkpoint = succeeded.get(i);
        if (checkpoint) ctx.steps[step.id] = checkpoint.output;
      });

      for (let i = 0; i < steps.length; i++) {
        if (succeeded.has(i)) continue;
        const step = steps[i];
        signal?.throwIfAborted();
        if (step.type === 'delay') {
          const output = { waitedMs: step.ms };
          if (waiting.has(i) && (await this.queue.wakeUp(job, this.workerId, i, output)) === 'resumed') {
            ctx.steps[step.id] = output;
            continue;
          }
          if (!waiting.has(i)) await this.queue.sleep(job, this.workerId, i, step.id, step.ms);
          return;
        }
        const idempotencyKey = step.type === 'http' ? stepIdempotencyKey(execution.id, step.id) : null;
        const stepRunId = await this.queue.startStep(job, this.workerId, i, step.id, idempotencyKey);
        let output: unknown;
        try {
          output = await this.executor.execute(step, ctx, { signal, idempotencyKey: idempotencyKey ?? undefined });
        } catch (err) {
          await this.recordStepFailure(job, stepRunId, err as Error);
          throw err;
        }
        await this.queue.finishStep(job, this.workerId, stepRunId, { output });
        ctx.steps[step.id] = output;
      }
      const last = steps[steps.length - 1];
      const completed = await this.queue.complete(job, this.workerId, {
        status: 'succeeded',
        output: ctx.steps[last.id] as object,
        finishedAt: new Date(),
      });
      if (!completed) this.logger.warn(`job ${job.id} finished after its lease was lost; result discarded`);
    } catch (err) {
      const leaseLost = err instanceof LeaseLostError ? err : signal?.reason instanceof LeaseLostError ? signal.reason : null;
      if (leaseLost) {
        this.logger.warn(leaseLost.message);
        return;
      }
      if (signal?.aborted && signal.reason instanceof WorkerShutdownError) {
        await this.queue.release(job, this.workerId);
        return;
      }
      const retryable = err instanceof StepError ? err.retryable : true;
      await this.queue.fail(job, this.workerId, (err as Error).message, retryable, {
        baseMs: this.config.retryBaseMs,
        capMs: this.config.retryCapMs,
      });
    }
  }

  private async recordStepFailure(job: Job, stepRunId: string, err: Error): Promise<void> {
    try {
      await this.queue.finishStep(job, this.workerId, stepRunId, { error: err.message });
    } catch (recordError) {
      if (!(recordError instanceof LeaseLostError)) throw recordError;
    }
  }
}
