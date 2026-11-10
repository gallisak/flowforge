import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { AuthenticatedTenant } from '../db/tenant-db.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { ExecutionsService } from './executions.service';

@Controller()
@UseGuards(ApiKeyGuard)
export class ExecutionsController {
  constructor(
    private readonly executions: ExecutionsService,
    private readonly workflows: WorkflowsService,
  ) {}

  @Post('workflows/:id/run')
  async run(
    @CurrentTenant() t: AuthenticatedTenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: Record<string, unknown> = {},
  ) {
    const workflow = await this.workflows.get(t.id, id);
    return this.executions.enqueue(workflow, input ?? {}, 'api');
  }

  @Get('executions')
  list(@CurrentTenant() t: AuthenticatedTenant, @Query('limit') limit?: string) {
    return this.executions.list(t.id, limit ? Number(limit) : undefined);
  }

  @Get('executions/:id')
  get(@CurrentTenant() t: AuthenticatedTenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.executions.get(t.id, id);
  }
}
