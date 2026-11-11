import { IsUrl, MaxLength } from 'class-validator';

export class NotificationEndpointDto {
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false, allow_underscores: true })
  @MaxLength(2048)
  url: string;
}
