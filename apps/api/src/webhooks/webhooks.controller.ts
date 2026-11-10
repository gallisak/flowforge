import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Request } from 'express';
import { RawBodyRequest } from '../app.setup';
import { TenantDb } from '../db/tenant-db.service';
import { Tenant, Workflow } from '../entities';
import { ExecutionsService } from '../executions/executions.service';
import { signatureMatches, webhookSignature } from './signature';

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
    @Req() req: Request & RawBodyRequest,
    @Headers('x-signature') signature?: string,
  ) {
    if (!req.is('application/json') || !req.rawBody) throw new UnsupportedMediaTypeException('Webhook body must be application/json');
    const body: unknown = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BadRequestException('Webhook body must be a JSON object');
    const tenantId = await this.db.resolveWebhookTenant(workflowId);
    if (!tenantId) throw new NotFoundException();
    const { workflow, tenant } = await this.db.run(tenantId, async (em) => ({
      workflow: await em.findOne(Workflow, { where: { id: workflowId } }),
      tenant: await em.findOne(Tenant, { where: { id: tenantId } }),
    }));
    if (!workflow || !workflow.enabled || !tenant) throw new NotFoundException();

    if (!signatureMatches(webhookSignature(tenant.webhookSecret, req.rawBody), signature)) {
      throw new UnauthorizedException('Invalid signature');
    }

    const execution = await this.executions.enqueue(workflow, body as Record<string, unknown>, 'webhook');
    return { executionId: execution.id };
  }
}
