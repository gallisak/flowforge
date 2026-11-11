import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { AuthenticatedTenant } from '../db/tenant-db.service';
import { WebhookSecretsService } from '../webhooks/webhook-secrets.service';
import { NotificationEndpointDto } from './notification-endpoint.dto';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(ApiKeyGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly secrets: WebhookSecretsService,
  ) {}

  @Get('endpoint')
  getEndpoint(@CurrentTenant() t: AuthenticatedTenant) {
    return this.notifications.get(t.id);
  }

  @Put('endpoint')
  setEndpoint(@CurrentTenant() t: AuthenticatedTenant, @Body() body: NotificationEndpointDto) {
    return this.notifications.set(t.id, body.url);
  }

  @Delete('endpoint')
  @HttpCode(204)
  removeEndpoint(@CurrentTenant() t: AuthenticatedTenant) {
    return this.notifications.remove(t.id);
  }

  @Get('secrets')
  listSecrets(@CurrentTenant() t: AuthenticatedTenant) {
    return this.secrets.list(t.id, 'outbound');
  }

  @Post('secrets')
  rotateSecret(@CurrentTenant() t: AuthenticatedTenant) {
    return this.secrets.rotate(t.id, 'outbound');
  }

  @Delete('secrets/:id')
  @HttpCode(204)
  revokeSecret(@CurrentTenant() t: AuthenticatedTenant, @Param('id', ParseUUIDPipe) id: string) {
    return this.secrets.revoke(t.id, id, 'outbound');
  }
}
