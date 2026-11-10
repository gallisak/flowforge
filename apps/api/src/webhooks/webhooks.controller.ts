import { Body, Controller, Headers, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac } from 'crypto';
import { Repository } from 'typeorm';
import { Tenant, Workflow } from '../entities';
import { ExecutionsService } from '../executions/executions.service';

@Controller('hooks')
export class WebhooksController {
  constructor(
    @InjectRepository(Workflow) private readonly workflows: Repository<Workflow>,
    @InjectRepository(Tenant) private readonly tenants: Repository<Tenant>,
    private readonly executions: ExecutionsService,
  ) {}

  @Post(':workflowId')
  @HttpCode(202)
  async receive(
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @Body() body: Record<string, unknown>,
    @Headers('x-signature') signature?: string,
  ) {
    const workflow = await this.workflows.findOne({ where: { id: workflowId } });
    if (!workflow || !workflow.enabled) throw new NotFoundException();
    const tenant = await this.tenants.findOneOrFail({ where: { id: workflow.tenantId } });

    const expected = createHmac('sha256', tenant.webhookSecret).update(JSON.stringify(body)).digest('hex');
    if (signature !== expected) {
      throw new UnauthorizedException('Invalid signature');
    }

    const execution = await this.executions.enqueue(workflow, body, 'webhook');
    return { executionId: execution.id };
  }
}
