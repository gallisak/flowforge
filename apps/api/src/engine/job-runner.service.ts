import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
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
    @InjectRepository(Execution) private readonly executions: Repository<Execution>,
    @InjectRepository(Workflow) private readonly workflows: Repository<Workflow>,
    @InjectRepository(StepRun) private readonly stepRuns: Repository<StepRun>,
  ) {}

  start(concurrency = Number(process.env.WORKER_CONCURRENCY ?? 4)): void {
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
    const execution = await this.executions.findOneOrFail({ where: { id: job.executionId } });
    const workflow = await this.workflows.findOneOrFail({ where: { id: execution.workflowId } });

    await this.executions.update(execution.id, { status: 'running' });
    const ctx: StepContext = { input: execution.input, steps: {} };

    try {
      for (let i = 0; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];
        const run = await this.stepRuns.save(
          this.stepRuns.create({ executionId: execution.id, stepIndex: i, stepId: step.id }),
        );
        try {
          const output = await this.executor.execute(step, ctx);
          ctx.steps[step.id] = output;
          await this.stepRuns.update(run.id, { status: 'succeeded', output: output as object });
        } catch (err) {
          await this.stepRuns.update(run.id, { status: 'failed', error: (err as Error).message });
          throw err;
        }
      }
      const last = workflow.steps[workflow.steps.length - 1];
      await this.executions.update(execution.id, {
        status: 'succeeded',
        output: ctx.steps[last.id] as object,
        finishedAt: new Date(),
      });
      await this.queue.complete(job.id);
    } catch (err) {
      const retryable = err instanceof StepError ? err.retryable : true;
      const willRetry = await this.queue.fail(job, (err as Error).message, retryable);
      if (!willRetry) {
        await this.executions.update(execution.id, {
          status: 'failed',
          error: (err as Error).message,
          finishedAt: new Date(),
        });
      }
    }
  }
}
