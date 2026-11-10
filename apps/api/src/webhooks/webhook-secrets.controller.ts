import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { AuthenticatedTenant } from '../db/tenant-db.service';
import { WebhookSecretsService } from './webhook-secrets.service';

@Controller('webhook-secrets')
@UseGuards(ApiKeyGuard)
export class WebhookSecretsController {
  constructor(private readonly secrets: WebhookSecretsService) {}

  @Get()
  list(@CurrentTenant() t: AuthenticatedTenant) {
    return this.secrets.list(t.id);
  }

  @Post()
  rotate(@CurrentTenant() t: AuthenticatedTenant) {
    return this.secrets.rotate(t.id);
  }

  @Delete(':id')
  @HttpCode(204)
  revoke(@CurrentTenant() t: AuthenticatedTenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.secrets.revoke(t.id, id);
  }
}
