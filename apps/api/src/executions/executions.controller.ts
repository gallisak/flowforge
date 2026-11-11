import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { JsonObjectPipe } from '../common/json-object.pipe';
import { AuthenticatedTenant } from '../db/tenant-db.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { ExecutionStreamService } from './execution-stream.service';
import { ExecutionsService } from './executions.service';

export class ListExecutionsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

@Controller()
@UseGuards(ApiKeyGuard)
export class ExecutionsController {
  constructor(
    private readonly executions: ExecutionsService,
    private readonly workflows: WorkflowsService,
    private readonly streams: ExecutionStreamService,
  ) {}

  @Post('workflows/:id/run')
  async run(
    @CurrentTenant() t: AuthenticatedTenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(JsonObjectPipe) input: Record<string, unknown>,
  ) {
    const workflow = await this.workflows.get(t.id, id);
    return this.executions.enqueue(workflow, input, 'api');
  }

  @Get('executions')
  list(@CurrentTenant() t: AuthenticatedTenant, @Query() query: ListExecutionsQuery) {
    return this.executions.list(t.id, query.limit);
  }

  @Get('executions/:id/events')
  events(
    @CurrentTenant() t: AuthenticatedTenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    return this.streams.stream(t.id, id, req, res);
  }

  @Get('executions/:id')
  get(@CurrentTenant() t: AuthenticatedTenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.executions.get(t.id, id);
  }
}
