import { BadRequestException } from '@nestjs/common';
import { StepDefinition } from '../entities';

const STEP_TYPES = ['http', 'transform', 'log', 'delay'] as const;

export function validateSteps(raw: unknown): StepDefinition[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) {
    throw new BadRequestException('steps must be an array of 1 to 50 items');
  }
  const seen = new Set<string>();
  raw.forEach((s, i) => {
    if (typeof s !== 'object' || s === null) throw new BadRequestException(`steps[${i}] must be an object`);
    const step = s as Record<string, unknown>;
    if (typeof step.id !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(step.id)) {
      throw new BadRequestException(`steps[${i}].id is invalid`);
    }
    if (seen.has(step.id)) throw new BadRequestException(`Duplicate step id: ${step.id}`);
    seen.add(step.id);
    if (!STEP_TYPES.includes(step.type as (typeof STEP_TYPES)[number])) {
      throw new BadRequestException(`steps[${i}].type is unknown`);
    }
    if (step.type === 'http' && typeof step.url !== 'string') throw new BadRequestException(`steps[${i}].url is required`);
    if (step.type === 'transform' && typeof step.expr !== 'string') throw new BadRequestException(`steps[${i}].expr is required`);
    if (step.type === 'log' && typeof step.message !== 'string') throw new BadRequestException(`steps[${i}].message is required`);
    if (step.type === 'delay' && !(typeof step.ms === 'number' && step.ms >= 0 && step.ms <= 3_600_000)) {
      throw new BadRequestException(`steps[${i}].ms must be a number in 0..3600000`);
    }
  });
  return raw as StepDefinition[];
}
