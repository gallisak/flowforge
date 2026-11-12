import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { SCHEDULER_CONFIG, SchedulerConfig } from '../config/config';
import { DueSchedule, TenantDb } from '../db/tenant-db.service';
import { Workflow } from '../entities';
import { ExecutionsService } from '../executions/executions.service';
import { TooManyRequestsException } from '../limits/too-many-requests';
import { metrics } from '../observability/metrics';
import { planFiring } from './cron-schedule';

export function cronTriggerKey(workflowId: string, scheduledAt: Date): string {
  return `cron:${workflowId}:${scheduledAt.toISOString()}`;
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
    const now = new Date();
    let fired = 0;
    while (!this.stopped) {
      const current: { schedule?: DueSchedule } = {};
      try {
        const outcome = await this.db.claimDueSchedule(now, (schedule, em) => {
          current.schedule = schedule;
          return this.fire(schedule, em, now);
        });
        if (!outcome.claimed) break;
        fired += outcome.result;
        metrics.scheduledRuns.inc({ outcome: 'started' }, outcome.result);
      } catch (error) {
        if (!current.schedule) throw error;
        const { id, tenantId } = current.schedule;
        await this.db.run(tenantId, (em) => this.postpone(em, { id, tenantId }, now));
        this.logger.warn(`workflow ${id}: scheduled run postponed (${(error as Error).message})`);
      }
    }
    return fired;
  }

  private async postpone(em: EntityManager, workflow: Pick<Workflow, 'id' | 'tenantId'>, now: Date, nextRunAt?: Date): Promise<void> {
    const scheduleRetryAt = new Date(now.getTime() + this.config.schedulerPostponeMs);
    await em.update(Workflow, workflow, nextRunAt ? { nextRunAt, scheduleRetryAt } : { scheduleRetryAt });
    metrics.scheduledRuns.inc({ outcome: 'postponed' });
  }

  private async fire(schedule: DueSchedule, em: EntityManager, now: Date): Promise<number> {
    const workflow = { id: schedule.id, tenantId: schedule.tenantId };
    const plan = planFiring(schedule, schedule.missedRunPolicy, schedule.nextRunAt, now, {
      misfireGraceMs: this.config.schedulerMisfireGraceMs,
      maxCatchUpRuns: this.config.schedulerMaxCatchUpRuns,
    });
    if (plan.skippedRuns > 0) {
      metrics.scheduledRuns.inc({ outcome: 'skipped' }, plan.skippedRuns);
      this.logger.warn(
        `workflow ${schedule.id}: ${plan.skippedRuns}${plan.skippedRunsCapped ? ' or more' : ''} missed runs since ` +
          `${schedule.nextRunAt.toISOString()} were not started (missed run policy ${schedule.missedRunPolicy})`,
      );
    }
    let started = 0;
    for (const scheduledAt of plan.fire) {
      try {
        await this.executions.enqueueWithin(
          em,
          schedule,
          { scheduledAt: scheduledAt.toISOString() },
          'cron',
          cronTriggerKey(schedule.id, scheduledAt),
        );
      } catch (error) {
        if (!(error instanceof TooManyRequestsException)) throw error;
        this.logger.warn(`workflow ${schedule.id}: queue limit reached, ${plan.fire.length - started} scheduled runs postponed`);
        await this.postpone(em, workflow, now, scheduledAt);
        return started;
      }
      started++;
    }
    await em.update(Workflow, workflow, { nextRunAt: plan.nextRunAt, scheduleRetryAt: null });
    return started;
  }
}
