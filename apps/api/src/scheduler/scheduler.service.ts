import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { SCHEDULER_CONFIG, SchedulerConfig } from '../config/config';
import { DueSchedule, TenantDb } from '../db/tenant-db.service';
import { Workflow } from '../entities';
import { ExecutionsService } from '../executions/executions.service';
import { TooManyRequestsException } from '../limits/too-many-requests';
import { runWithLogContext } from '../observability/log-context';
import { metrics } from '../observability/metrics';
import { planFiring } from './cron-schedule';

export function cronTriggerKey(workflowId: string, scheduledAt: Date): string {
  return `cron:${workflowId}:${scheduledAt.toISOString()}`;
}

interface FiringOutcome {
  started: number;
  postponed: boolean;
  skipped: { workflowId: string; runs: number; capped: boolean; since: Date; policy: string };
}

@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SchedulerService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly db: TenantDb,
    private readonly executions: ExecutionsService,
    @Inject(SCHEDULER_CONFIG) private readonly config: SchedulerConfig,
  ) {}

  get isRunning(): boolean {
    return !this.stopped;
  }

  onApplicationBootstrap(): void {
    this.scheduleNextTick();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private scheduleNextTick(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick()
        .then(
          () => undefined,
          (error: Error) => this.logger.error(`scheduler tick failed: ${error.message}`),
        )
        .finally(() => {
          this.running = undefined;
          this.scheduleNextTick();
        });
    }, this.config.schedulerTickMs);
  }

  async tick(): Promise<number> {
    let fired = 0;
    while (!this.stopped) {
      const now = new Date();
      const current: { schedule?: DueSchedule } = {};
      try {
        const outcome = await this.db.claimDueSchedule(now, (schedule, em) => {
          current.schedule = schedule;
          return this.fire(schedule, em, now);
        });
        if (!outcome.claimed) break;
        const { started, postponed, skipped } = outcome.result;
        fired += started;
        metrics.scheduledRuns.inc({ outcome: 'started' }, started);
        if (postponed) metrics.scheduledRuns.inc({ outcome: 'postponed' });
        if (skipped.runs > 0) {
          metrics.scheduledRuns.inc({ outcome: 'skipped' }, skipped.runs);
          this.logger.warn(
            `workflow ${skipped.workflowId}: ${skipped.runs}${skipped.capped ? ' or more' : ''} missed runs since ` +
              `${skipped.since.toISOString()} were not started (missed run policy ${skipped.policy})`,
          );
        }
      } catch (error) {
        if (!current.schedule) throw error;
        const { id, tenantId, nextRunAt } = current.schedule;
        await this.db.run(tenantId, (em) => this.postpone(em, { id, tenantId, nextRunAt }, now));
        metrics.scheduledRuns.inc({ outcome: 'postponed' });
        this.logger.warn(`workflow ${id}: scheduled run postponed (${(error as Error).message})`);
      }
    }
    return fired;
  }

  private async postpone(
    em: EntityManager,
    workflow: Pick<Workflow, 'id' | 'tenantId'> & Partial<Pick<Workflow, 'nextRunAt'>>,
    now: Date,
    nextRunAt?: Date,
  ): Promise<void> {
    const scheduleRetryAt = new Date(now.getTime() + this.config.schedulerPostponeMs);
    await em.update(Workflow, workflow, nextRunAt ? { nextRunAt, scheduleRetryAt } : { scheduleRetryAt });
  }

  private async fire(schedule: DueSchedule, em: EntityManager, now: Date): Promise<FiringOutcome> {
    const workflow = { id: schedule.id, tenantId: schedule.tenantId };
    const plan = planFiring(schedule, schedule.missedRunPolicy, schedule.nextRunAt, now, {
      misfireGraceMs: this.config.schedulerMisfireGraceMs,
      maxCatchUpRuns: this.config.schedulerMaxCatchUpRuns,
    });
    const skipped = {
      workflowId: schedule.id,
      runs: plan.skippedRuns,
      capped: plan.skippedRunsCapped,
      since: schedule.nextRunAt,
      policy: schedule.missedRunPolicy,
    };
    let started = 0;
    for (const [index, scheduledAt] of plan.fire.entries()) {
      try {
        const { created } = await runWithLogContext({ correlationId: randomUUID(), tenantId: schedule.tenantId }, () =>
          this.executions.enqueueWithin(em, schedule, { scheduledAt: scheduledAt.toISOString() }, 'cron', cronTriggerKey(schedule.id, scheduledAt)),
        );
        if (created) started++;
      } catch (error) {
        if (!(error instanceof TooManyRequestsException)) throw error;
        this.logger.warn(`workflow ${schedule.id}: queue limit reached, ${plan.fire.length - index} scheduled runs postponed`);
        await this.postpone(em, workflow, now, scheduledAt);
        return { started, postponed: true, skipped };
      }
    }
    await em.update(Workflow, workflow, { nextRunAt: plan.nextRunAt, scheduleRetryAt: null });
    return { started, postponed: false, skipped };
  }
}
