import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKeyGuard } from './auth/api-key.guard';
import { JobQueueService } from './engine/job-queue.service';
import { JobRunnerService } from './engine/job-runner.service';
import { StepExecutor } from './engine/step-executor';
import { Execution, Job, StepRun, Tenant, Workflow } from './entities';
import { ExecutionsController } from './executions/executions.controller';
import { ExecutionsService } from './executions/executions.service';
import { SchedulerService } from './scheduler/scheduler.service';
import { TenantsController } from './tenants/tenants.controller';
import { WebhooksController } from './webhooks/webhooks.controller';
import { WorkflowsController } from './workflows/workflows.controller';
import { WorkflowsService } from './workflows/workflows.service';

export const entities = [Tenant, Workflow, Execution, StepRun, Job];

export const databaseModule = TypeOrmModule.forRootAsync({
  useFactory: () => ({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    entities,
    synchronize: true,
  }),
});

@Module({
  imports: [databaseModule, TypeOrmModule.forFeature(entities)],
  controllers: [TenantsController, WorkflowsController, ExecutionsController, WebhooksController],
  providers: [ApiKeyGuard, WorkflowsService, ExecutionsService, SchedulerService],
})
export class AppModule {}

@Module({
  imports: [databaseModule, TypeOrmModule.forFeature(entities)],
  providers: [JobQueueService, JobRunnerService, StepExecutor],
})
export class WorkerModule {}
