import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { TenantDb } from '../db/tenant-db.service';
import { Execution, Job, StepRun, Workflow } from '../entities';
import { JobQueueService } from './job-queue.service';
import { StepError, StepExecutor } from './step-executor';
import { StepContext } from './template';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class JobRunnerService implements OnApplicationShutdown {
  private readonly logger = new Logger(JobRunnerService.name);
  readonly workerId = `worker-${randomUUID().slice(0, 8)}`;
  private running = false;

  constructor(
    private readonly queue: JobQueueService,
    private readonly executor: StepExecutor,
    private readonly db: TenantDb,
  ) {}

  start(concurrency: number): void {
    this.running = true;
    this.logger.log(`${this.workerId} started, concurrency=${concurrency}`);
    for (let i = 0; i < concurrency; i++) void this.loop();
  }

  onApplicationShutdown(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const job = await this.queue.claimNext(this.workerId);
        if (!job) {
          await sleep(250);
          continue;
        }
        await this.process(job);
      } catch (err) {
        this.logger.error(`loop error: ${(err as Error).message}`);
        await sleep(1000);
      }
    }
  }

  async process(job: Job): Promise<void> {
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
          const output = await this.executor.execute(step, ctx);
          ctx.steps[step.id] = output;
          await inTenant((em) => em.update(StepRun, run.id, { status: 'succeeded', output: output as object }));
        } catch (err) {
          await inTenant((em) => em.update(StepRun, run.id, { status: 'failed', error: (err as Error).message }));
          throw err;
        }
      }
      const last = workflow.steps[workflow.steps.length - 1];
      await inTenant((em) =>
        em.update(Execution, execution.id, {
          status: 'succeeded',
          output: ctx.steps[last.id] as object,
          finishedAt: new Date(),
        }),
      );
      await this.queue.complete(job);
    } catch (err) {
      const retryable = err instanceof StepError ? err.retryable : true;
      const willRetry = await this.queue.fail(job, (err as Error).message, retryable);
      if (!willRetry) {
        await inTenant((em) =>
          em.update(Execution, execution.id, {
            status: 'failed',
            error: (err as Error).message,
            finishedAt: new Date(),
          }),
        );
      }
    }
  }
}
