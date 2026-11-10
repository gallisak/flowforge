import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { parseExpression } from 'cron-parser';
import { API_CONFIG, ApiConfig } from '../config/config';
import { TenantDb } from '../db/tenant-db.service';
import { ExecutionsService } from '../executions/executions.service';

@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SchedulerService.name);
  private timer?: NodeJS.Timeout;
  private lastTick = new Date();

  constructor(
    private readonly db: TenantDb,
    private readonly executions: ExecutionsService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  onApplicationBootstrap(): void {
    const every = this.config.schedulerTickMs;
    this.timer = setInterval(() => void this.tick().catch((e) => this.logger.error(e.message)), every);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<number> {
    const scheduled = await this.db.listScheduledWorkflows();

    let fired = 0;
    for (const wf of scheduled) {
      try {
        const it = parseExpression(wf.cron, { currentDate: this.lastTick });
        for (let next = it.next().toDate(); next <= now; next = it.next().toDate()) {
          await this.executions.enqueue(wf, {}, 'cron');
          fired++;
        }
      } catch (err) {
        this.logger.warn(`workflow ${wf.id}: invalid cron (${(err as Error).message})`);
      }
    }
    this.lastTick = now;
    return fired;
  }
}
