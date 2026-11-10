import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
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
import { API_CONFIG, ApiConfig } from '../config/config';
import { TenantDb } from '../db/tenant-db.service';
import { Tenant, Workflow } from '../entities';
import { ExecutionsService } from '../executions/executions.service';
import { verifyWebhook } from './signature';

@Controller('hooks')
export class WebhooksController {
  constructor(
    private readonly db: TenantDb,
    private readonly executions: ExecutionsService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post(':workflowId')
  @HttpCode(202)
  async receive(
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @Req() req: Request & RawBodyRequest,
    @Headers('webhook-id') id?: string,
    @Headers('webhook-timestamp') timestamp?: string,
    @Headers('webhook-signature') signature?: string,
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

    const nowSeconds = Math.floor(Date.now() / 1000);
    const messageId = verifyWebhook([tenant.webhookSecret], { id, timestamp, signature }, req.rawBody, nowSeconds, this.config.webhookToleranceSeconds);
    if (!messageId) throw new UnauthorizedException('Invalid signature');

    const execution = await this.executions.enqueue(
      workflow,
      body as Record<string, unknown>,
      'webhook',
      `webhook:${workflowId}:${messageId}`,
    );
    return { executionId: execution.id };
  }
}
