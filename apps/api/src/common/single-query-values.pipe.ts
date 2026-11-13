import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class SingleQueryValuesPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'query') return value;
    if (metadata.data !== undefined && Array.isArray(value)) throw new BadRequestException(`query parameter ${metadata.data} must be given once`);
    if (value === null || typeof value !== 'object') return value;
    const repeated = Object.entries(value).find(([, item]) => Array.isArray(item));
    if (repeated) throw new BadRequestException(`query parameter ${repeated[0]} must be given once`);
    return value;
  }
}
