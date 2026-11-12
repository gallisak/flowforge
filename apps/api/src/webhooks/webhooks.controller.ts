import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { RawBodyRequest } from '../app.setup';
import { API_CONFIG, ApiConfig } from '../config/config';
import { TenantDb } from '../db/tenant-db.service';
import { Workflow } from '../entities';
import { ExecutionsService } from '../executions/executions.service';
import { AuthFailureLimiter, clientAddressOf } from '../limits/auth-failure-limiter';
import { RateLimitService } from '../limits/rate-limit.service';
import { verifyWebhook } from './signature';
import { WebhookSecretsService } from './webhook-secrets.service';

@Controller('hooks')
export class WebhooksController {
  constructor(
    private readonly db: TenantDb,
    private readonly executions: ExecutionsService,
    private readonly secrets: WebhookSecretsService,
    private readonly rateLimit: RateLimitService,
    private readonly failures: AuthFailureLimiter,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post(':workflowId')
  @HttpCode(202)
  async receive(
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @Req() req: Request & RawBodyRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('webhook-id') id?: string,
    @Headers('webhook-timestamp') timestamp?: string,
    @Headers('webhook-signature') signature?: string,
  ) {
    if (!req.is('application/json')) throw new UnsupportedMediaTypeException('Webhook body must be application/json');
    const body: unknown = req.body;
    if (!req.rawBody?.length || typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException('Webhook body must be a JSON object');
    }
    const address = clientAddressOf(req);
    this.failures.assertAllowed(address);
    const reject = () => {
      this.failures.recordFailure(address);
      return new UnauthorizedException('Invalid signature');
    };
    const tenantId = await this.db.resolveWebhookTenant(workflowId);
    if (!tenantId) throw reject();
    const { workflow, secrets } = await this.db.run(tenantId, async (em) => ({
      workflow: await em.findOne(Workflow, { where: { id: workflowId } }),
      secrets: await this.secrets.activeSecrets(em, tenantId),
    }));
    if (!workflow || !workflow.enabled) throw reject();

    const nowSeconds = Math.floor(Date.now() / 1000);
    const messageId = verifyWebhook(
      secrets.map((s) => s.secret),
      { id, timestamp, signature },
      req.rawBody,
      nowSeconds,
      this.config.webhookToleranceSeconds,
    );
    if (!messageId) throw reject();
    await this.rateLimit.consume(tenantId, res);

    const execution = await this.executions.enqueue(
      workflow,
      body as Record<string, unknown>,
      'webhook',
      `webhook:${workflowId}:${messageId}`,
    );
    return { executionId: execution.id };
  }
}
