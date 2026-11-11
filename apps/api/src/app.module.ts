import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKeyGuard } from './auth/api-key.guard';
import { API_CONFIG, ApiConfig, SCHEDULER_CONFIG, SchedulerConfig, WORKER_CONFIG, WorkerConfig } from './config/config';
import { ApiConfigModule, SchedulerConfigModule, WorkerConfigModule } from './config/config.module';
import { dataSourceOptions, entities } from './db/data-source';
import { TenantDb } from './db/tenant-db.service';
import { JobQueueService } from './engine/job-queue.service';
import { JobRunnerService } from './engine/job-runner.service';
import { OutboxDispatcher } from './outbox/outbox-dispatcher.service';
import { StepExecutor } from './engine/step-executor';
import { ExecutionsController } from './executions/executions.controller';
import { ExecutionEventsHub } from './executions/execution-events.hub';
import { ExecutionStreamService } from './executions/execution-stream.service';
import { ExecutionsService } from './executions/executions.service';
import { SchedulerService } from './scheduler/scheduler.service';
import { TenantsController } from './tenants/tenants.controller';
import { RateLimitService } from './limits/rate-limit.service';
import { WebhookSecretsController } from './webhooks/webhook-secrets.controller';
import { WebhookSecretsService } from './webhooks/webhook-secrets.service';
import { WebhooksController } from './webhooks/webhooks.controller';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { WorkflowsController } from './workflows/workflows.controller';
import { WorkflowsService } from './workflows/workflows.service';

@Module({
  imports: [
    ApiConfigModule,
    TypeOrmModule.forRootAsync({
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => dataSourceOptions(config.databaseUrl, config.databaseTimeouts),
    }),
    TypeOrmModule.forFeature(entities),
  ],
  controllers: [
    TenantsController,
    WorkflowsController,
    ExecutionsController,
    WebhooksController,
    WebhookSecretsController,
    NotificationsController,
  ],
  providers: [
    TenantDb,
    ApiKeyGuard,
    WorkflowsService,
    ExecutionsService,
    WebhookSecretsService,
    RateLimitService,
    NotificationsService,
    ExecutionEventsHub,
    ExecutionStreamService,
  ],
})
export class AppModule {}

@Module({
  imports: [
    WorkerConfigModule,
    TypeOrmModule.forRootAsync({
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => dataSourceOptions(config.databaseUrl, config.databaseTimeouts),
    }),
    TypeOrmModule.forFeature(entities),
  ],
  providers: [TenantDb, JobQueueService, JobRunnerService, StepExecutor, OutboxDispatcher],
})
export class WorkerModule {}

@Module({
  imports: [
    SchedulerConfigModule,
    TypeOrmModule.forRootAsync({
      inject: [SCHEDULER_CONFIG],
      useFactory: (config: SchedulerConfig) => dataSourceOptions(config.databaseUrl, config.databaseTimeouts),
    }),
    TypeOrmModule.forFeature(entities),
  ],
  providers: [TenantDb, ExecutionsService, SchedulerService],
})
export class SchedulerModule {}
