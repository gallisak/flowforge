import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedTenant } from '../db/tenant-db.service';
import { TenantRequest } from './api-key.guard';

export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedTenant => {
  return ctx.switchToHttp().getRequest<TenantRequest>().tenant;
});
