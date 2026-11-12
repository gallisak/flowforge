import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { WORKER_CONFIG, WorkerConfig } from '../config/config';
import { TenantDb } from '../db/tenant-db.service';

const PURGE_BATCH = 1_000;
const MAX_BATCHES_PER_RUN = 20;

@Injectable()
export class RetentionService implements OnApplicationShutdown {
  private readonly logger = new Logger(RetentionService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = true;

  constructor(
    private readonly db: TenantDb,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  start(): void {
    if (this.config.retentionDays === 0) return;
    this.stopped = false;
    this.scheduleNextRun();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private scheduleNextRun(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.purge()
        .catch((error: Error) => this.logger.error(`retention run failed: ${error.message}`))
        .finally(() => {
          this.running = undefined;
          this.scheduleNextRun();
        });
    }, this.config.retentionIntervalMs);
  }

  async purge(): Promise<void> {
    const total = { executions: 0, outboxEvents: 0, workflowVersions: 0 };
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN && !this.stopped; batch++) {
      const purged = await this.db.purgeFinishedData(this.config.retentionDays, PURGE_BATCH);
      total.executions += purged.executions;
      total.outboxEvents += purged.outboxEvents;
      total.workflowVersions += purged.workflowVersions;
      if (Math.max(purged.executions, purged.outboxEvents, purged.workflowVersions) < PURGE_BATCH) break;
    }
    if (total.executions + total.outboxEvents + total.workflowVersions > 0) {
      this.logger.log({ msg: 'finished data purged', retentionDays: this.config.retentionDays, ...total });
    }
  }
}
