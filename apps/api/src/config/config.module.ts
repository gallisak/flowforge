import { Global, Module } from '@nestjs/common';
import {
  API_CONFIG,
  ApiConfig,
  loadApiConfig,
  loadSchedulerConfig,
  loadWorkerConfig,
  QUEUE_LIMITS,
  QueueLimits,
  SCHEDULER_CONFIG,
  SchedulerConfig,
  WORKER_CONFIG,
} from './config';

@Global()
@Module({
  providers: [
    { provide: API_CONFIG, useFactory: () => loadApiConfig() },
    {
      provide: QUEUE_LIMITS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig): QueueLimits => ({ tenantMaxQueuedJobs: config.tenantMaxQueuedJobs }),
    },
  ],
  exports: [API_CONFIG, QUEUE_LIMITS],
})
export class ApiConfigModule {}

@Global()
@Module({
  providers: [{ provide: WORKER_CONFIG, useFactory: () => loadWorkerConfig() }],
  exports: [WORKER_CONFIG],
})
export class WorkerConfigModule {}

@Global()
@Module({
  providers: [
    { provide: SCHEDULER_CONFIG, useFactory: () => loadSchedulerConfig() },
    {
      provide: QUEUE_LIMITS,
      inject: [SCHEDULER_CONFIG],
      useFactory: (config: SchedulerConfig): QueueLimits => ({ tenantMaxQueuedJobs: config.tenantMaxQueuedJobs }),
    },
  ],
  exports: [SCHEDULER_CONFIG, QUEUE_LIMITS],
})
export class SchedulerConfigModule {}
