import { Body, Controller, Headers, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { TenantDb } from '../db/tenant-db.service';
import { Tenant, Workflow } from '../entities';
import { ExecutionsService } from '../executions/executions.service';

@Controller('hooks')
export class WebhooksController {
  constructor(
    private readonly db: TenantDb,
    private readonly executions: ExecutionsService,
  ) {}

  @Post(':workflowId')
  @HttpCode(202)
  async receive(
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @Body() body: Record<string, unknown>,
    @Headers('x-signature') signature?: string,
  ) {
    const tenantId = await this.db.resolveWebhookTenant(workflowId);
    if (!tenantId) throw new NotFoundException();
    const { workflow, tenant } = await this.db.run(tenantId, async (em) => ({
      workflow: await em.findOne(Workflow, { where: { id: workflowId } }),
      tenant: await em.findOne(Tenant, { where: { id: tenantId } }),
    }));
    if (!workflow || !workflow.enabled || !tenant) throw new NotFoundException();

    const expected = createHmac('sha256', tenant.webhookSecret).update(JSON.stringify(body)).digest('hex');
    if (signature !== expected) {
      throw new UnauthorizedException('Invalid signature');
    }

    const execution = await this.executions.enqueue(workflow, body, 'webhook');
    return { executionId: execution.id };
  }
}
