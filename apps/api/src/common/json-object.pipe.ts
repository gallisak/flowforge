import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class JsonObjectPipe implements PipeTransform<unknown, Record<string, unknown>> {
  transform(value: unknown): Record<string, unknown> {
    if (value === undefined) return {};
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BadRequestException('Request body must be a JSON object');
    }
    return value as Record<string, unknown>;
  }
}
