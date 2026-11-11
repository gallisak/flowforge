import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { API_CONFIG, ApiConfig } from '../config/config';
import { DueSchedule, TenantDb } from '../db/tenant-db.service';
import { Workflow } from '../entities';
import { ExecutionsService } from '../executions/executions.service';
import { planFiring } from './cron-schedule';

@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SchedulerService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly db: TenantDb,
    private readonly executions: ExecutionsService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
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
          (error: Error) => this.logger.error(error.message),
        )
        .finally(() => {
          this.running = undefined;
          this.scheduleNextTick();
        });
    }, this.config.schedulerTickMs);
  }

  async tick(): Promise<number> {
    const now = new Date();
    const due = await this.db.listDueSchedules(now);

    let fired = 0;
    for (const schedule of due) {
      try {
        fired += await this.fire(schedule, now);
      } catch (error) {
        this.logger.warn(`workflow ${schedule.id}: scheduled run postponed to the next tick (${(error as Error).message})`);
      }
    }
    return fired;
  }

  private fire(schedule: DueSchedule, now: Date): Promise<number> {
    const plan = planFiring(schedule, schedule.missedRunPolicy, schedule.nextRunAt, now, {
      misfireGraceMs: this.config.schedulerMisfireGraceMs,
      maxCatchUpRuns: this.config.schedulerMaxCatchUpRuns,
    });
    if (plan.droppedMissedRuns) {
      this.logger.warn(`workflow ${schedule.id}: only the latest ${this.config.schedulerMaxCatchUpRuns} missed runs were started`);
    }
    return this.db.run(schedule.tenantId, async (em) => {
      for (const scheduledAt of plan.fire) {
        await this.executions.enqueueWithin(em, schedule, { scheduledAt: scheduledAt.toISOString() }, 'cron');
      }
      await em.update(Workflow, { id: schedule.id, tenantId: schedule.tenantId }, { nextRunAt: plan.nextRunAt });
      return plan.fire.length;
    });
  }
}
