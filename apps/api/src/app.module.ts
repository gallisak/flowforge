import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKeyGuard } from './auth/api-key.guard';
import { API_CONFIG, ApiConfig, WORKER_CONFIG, WorkerConfig } from './config/config';
import { ApiConfigModule, WorkerConfigModule } from './config/config.module';
import { dataSourceOptions, entities } from './db/data-source';
import { TenantDb } from './db/tenant-db.service';
import { JobQueueService } from './engine/job-queue.service';
import { JobRunnerService } from './engine/job-runner.service';
import { StepExecutor } from './engine/step-executor';
import { ExecutionsController } from './executions/executions.controller';
import { ExecutionsService } from './executions/executions.service';
import { SchedulerService } from './scheduler/scheduler.service';
import { TenantsController } from './tenants/tenants.controller';
import { WebhooksController } from './webhooks/webhooks.controller';
import { WorkflowsController } from './workflows/workflows.controller';
import { WorkflowsService } from './workflows/workflows.service';

@Module({
  imports: [
    ApiConfigModule,
    TypeOrmModule.forRootAsync({
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => dataSourceOptions(config.databaseUrl),
    }),
    TypeOrmModule.forFeature(entities),
  ],
  controllers: [TenantsController, WorkflowsController, ExecutionsController, WebhooksController],
  providers: [TenantDb, ApiKeyGuard, WorkflowsService, ExecutionsService, SchedulerService],
})
export class AppModule {}

@Module({
  imports: [
    WorkerConfigModule,
    TypeOrmModule.forRootAsync({
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => dataSourceOptions(config.databaseUrl),
    }),
    TypeOrmModule.forFeature(entities),
  ],
  providers: [TenantDb, JobQueueService, JobRunnerService, StepExecutor],
})
export class WorkerModule {}
