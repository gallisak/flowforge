import { BadRequestException } from '@nestjs/common';
import { StepDefinition } from '../entities';

const STEP_TYPES = ['http', 'transform', 'log', 'delay'] as const;

/** Валідує масив кроків і повертає його типізованим. Кидає BadRequestException. */
export function validateSteps(raw: unknown): StepDefinition[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) {
    throw new BadRequestException('steps має бути масивом від 1 до 50 елементів');
  }
  const seen = new Set<string>();
  raw.forEach((s, i) => {
    if (typeof s !== 'object' || s === null) throw new BadRequestException(`steps[${i}] має бути об'єктом`);
    const step = s as Record<string, unknown>;
    if (typeof step.id !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(step.id)) {
      throw new BadRequestException(`steps[${i}].id невалідний`);
    }
    if (seen.has(step.id)) throw new BadRequestException(`Дубльований id кроку: ${step.id}`);
    seen.add(step.id);
    if (!STEP_TYPES.includes(step.type as (typeof STEP_TYPES)[number])) {
      throw new BadRequestException(`steps[${i}].type невідомий`);
    }
    if (step.type === 'http' && typeof step.url !== 'string') throw new BadRequestException(`steps[${i}].url обов'язковий`);
    if (step.type === 'transform' && typeof step.expr !== 'string') throw new BadRequestException(`steps[${i}].expr обов'язковий`);
    if (step.type === 'log' && typeof step.message !== 'string') throw new BadRequestException(`steps[${i}].message обов'язковий`);
    if (step.type === 'delay' && !(typeof step.ms === 'number' && step.ms >= 0 && step.ms <= 3_600_000)) {
      throw new BadRequestException(`steps[${i}].ms має бути числом 0..3600000`);
    }
  });
  return raw as StepDefinition[];
}
