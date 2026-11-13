import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min, MaxLength } from 'class-validator';
import { Response } from 'express';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { AuthenticatedTenant } from '../db/tenant-db.service';
import { CreateWorkflowDto, UpdateWorkflowDto } from './workflow.dto';
import { NEXT_CURSOR_HEADER } from '../executions/executions.controller';
import { Workflow } from '../entities';
import { WorkflowsService } from './workflows.service';
import { entityTagOf } from './workflow-precondition';

export class ListWorkflowsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

function tagged(res: Response, workflow: Workflow): Workflow {
  res.setHeader('etag', entityTagOf(workflow.revision));
  res.setHeader('access-control-expose-headers', 'ETag');
  return workflow;
}

@Controller('workflows')
@UseGuards(ApiKeyGuard)
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get()
  async list(@CurrentTenant() t: AuthenticatedTenant, @Query() query: ListWorkflowsQuery, @Res({ passthrough: true }) res: Response) {
    const page = await this.workflows.list(t.id, query);
    res.setHeader('access-control-expose-headers', NEXT_CURSOR_HEADER);
    if (page.nextCursor) res.setHeader(NEXT_CURSOR_HEADER, page.nextCursor);
    return page.items;
  }

  @Get(':id')
  async get(@CurrentTenant() t: AuthenticatedTenant, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    return tagged(res, await this.workflows.get(t.id, id));
  }

  @Post()
  create(@CurrentTenant() t: AuthenticatedTenant, @Body() body: CreateWorkflowDto) {
    return this.workflows.create(t.id, body);
  }

  @Patch(':id')
  async update(
    @CurrentTenant() t: AuthenticatedTenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateWorkflowDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return tagged(res, await this.workflows.update(t.id, id, body, ifMatch));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentTenant() t: AuthenticatedTenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.remove(t.id, id);
  }
}
