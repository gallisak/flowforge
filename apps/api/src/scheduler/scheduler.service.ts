import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { SCHEDULER_CONFIG, SchedulerConfig } from '../config/config';
import { DueSchedule, TenantDb } from '../db/tenant-db.service';
import { Workflow } from '../entities';
import { ExecutionsService } from '../executions/executions.service';
import { TooManyRequestsException } from '../limits/too-many-requests';
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
    const postponed: string[] = [];
    let fired = 0;
    while (!this.stopped) {
      const current: { schedule?: DueSchedule } = {};
      try {
        const outcome = await this.db.claimDueSchedule(now, postponed, (schedule, em) => {
          current.schedule = schedule;
          return this.fire(schedule, em, now);
        });
        if (!outcome.claimed) break;
        fired += outcome.result;
      } catch (error) {
        if (!current.schedule) throw error;
        postponed.push(current.schedule.id);
        this.logger.warn(`workflow ${current.schedule.id}: scheduled run postponed to the next tick (${(error as Error).message})`);
      }
    }
    return fired;
  }

  private async fire(schedule: DueSchedule, em: EntityManager, now: Date): Promise<number> {
    const plan = planFiring(schedule, schedule.missedRunPolicy, schedule.nextRunAt, now, {
      misfireGraceMs: this.config.schedulerMisfireGraceMs,
      maxCatchUpRuns: this.config.schedulerMaxCatchUpRuns,
    });
    if (plan.droppedMissedRuns) {
      this.logger.warn(`workflow ${schedule.id}: only the latest ${this.config.schedulerMaxCatchUpRuns} missed runs were started`);
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
        if (!(error instanceof TooManyRequestsException) || started === 0) throw error;
        this.logger.warn(`workflow ${schedule.id}: queue limit reached, ${plan.fire.length - started} scheduled runs postponed`);
        await em.update(Workflow, { id: schedule.id, tenantId: schedule.tenantId }, { nextRunAt: scheduledAt });
        return started;
      }
      started++;
    }
    await em.update(Workflow, { id: schedule.id, tenantId: schedule.tenantId }, { nextRunAt: plan.nextRunAt });
    return started;
  }
}
