import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { AuthenticatedTenant } from '../db/tenant-db.service';
import { WorkflowInput, WorkflowsService } from './workflows.service';

@Controller('workflows')
@UseGuards(ApiKeyGuard)
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get()
  list(@CurrentTenant() t: AuthenticatedTenant) {
    return this.workflows.list(t.id);
  }

  @Get(':id')
  get(@CurrentTenant() t: AuthenticatedTenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.get(t.id, id);
  }

  @Post()
  create(@CurrentTenant() t: AuthenticatedTenant, @Body() body: WorkflowInput) {
    return this.workflows.create(t.id, body);
  }

  @Patch(':id')
  update(@CurrentTenant() t: AuthenticatedTenant, @Param('id', ParseUUIDPipe) id: string, @Body() body: Partial<WorkflowInput>) {
    return this.workflows.update(t.id, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentTenant() t: AuthenticatedTenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.remove(t.id, id);
  }
}
