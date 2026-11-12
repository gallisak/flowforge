import type { MissedRunPolicy, StepDefinition, WorkflowDto } from './types';

export interface WorkflowFormValues {
  name: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  missedRunPolicy: MissedRunPolicy;
  steps: string;
}

export type WorkflowField = keyof WorkflowFormValues | 'form';
export type FieldErrors = Partial<Record<WorkflowField, string>>;

export interface WorkflowPayload {
  name: string;
  enabled: boolean;
  cron: string | null;
  timezone: string;
  missedRunPolicy: MissedRunPolicy;
  steps: StepDefinition[];
}

const STEP_TYPES = ['http', 'transform', 'log', 'delay'];
const STEP_ID = /^[a-z][a-z0-9_]{0,31}$/;
const POLICIES: MissedRunPolicy[] = ['skip', 'once', 'all'];
const MAX_DELAY_MS = 3_600_000;
const FIELDS: WorkflowField[] = ['name', 'enabled', 'cron', 'timezone', 'missedRunPolicy', 'steps'];

export const EXAMPLE_STEPS: StepDefinition[] = [
  { id: 'fetch', type: 'http', method: 'GET', url: 'https://api.example.com/orders/{{ input.orderId }}' },
  { id: 'summary', type: 'transform', expr: '({ total: ctx.steps.fetch.body.total })' },
  { id: 'note', type: 'log', message: 'order total {{ steps.summary.total }}' },
];

export function emptyValues(): WorkflowFormValues {
  return { name: '', enabled: true, cron: '', timezone: 'UTC', missedRunPolicy: 'once', steps: JSON.stringify(EXAMPLE_STEPS, null, 2) };
}

export function valuesFrom(workflow: WorkflowDto): WorkflowFormValues {
  return {
    name: workflow.name,
    enabled: workflow.enabled,
    cron: workflow.cron ?? '',
    timezone: workflow.timezone,
    missedRunPolicy: workflow.missedRunPolicy,
    steps: JSON.stringify(workflow.steps, null, 2),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stepProblem(step: unknown, index: number, seen: Set<string>): string | null {
  const at = `Step ${index + 1}`;
  if (!isObject(step)) return `${at} must be an object`;
  if (typeof step.id !== 'string' || step.id.trim() === '') return `${at} needs an id`;
  if (!STEP_ID.test(step.id)) return `${at} needs an id of lowercase letters, digits and _ that starts with a letter`;
  if (seen.has(step.id)) return `${at} repeats the id "${step.id}"`;
  seen.add(step.id);
  if (typeof step.type !== 'string' || !STEP_TYPES.includes(step.type)) return `${at} must have a type of ${STEP_TYPES.join(', ')}`;
  switch (step.type) {
    case 'http':
      if (typeof step.url !== 'string' || step.url.trim() === '') return `${at} needs a url`;
      if (step.method !== undefined && typeof step.method !== 'string') return `${at} has a method that is not text`;
      if (step.body !== undefined && typeof step.body !== 'string') return `${at} has a body that is not text`;
      if (step.headers !== undefined && (!isObject(step.headers) || Object.values(step.headers).some((v) => typeof v !== 'string'))) {
        return `${at} must have headers with text values`;
      }
      return null;
    case 'transform':
      return typeof step.expr === 'string' ? null : `${at} needs an expression`;
    case 'log':
      return typeof step.message === 'string' ? null : `${at} needs a message`;
    default:
      return typeof step.ms === 'number' && step.ms >= 0 && step.ms <= MAX_DELAY_MS
        ? null
        : `${at} needs a number of milliseconds from 0 to ${MAX_DELAY_MS}`;
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function validateWorkflow(values: WorkflowFormValues, original?: WorkflowDto): { errors: FieldErrors; payload?: WorkflowPayload } {
  const errors: FieldErrors = {};
  const nameUnchanged = original !== undefined && values.name === original.name;
  const name = nameUnchanged ? values.name : values.name.trim();
  if (!nameUnchanged && !name) errors.name = 'Name is required';
  else if (!nameUnchanged && name.length > 200) errors.name = 'Name must be at most 200 characters';

  const cron = values.cron.trim();
  if (cron && ![5, 6].includes(cron.split(/\s+/).length)) errors.cron = 'Cron must have 5 fields, or 6 with seconds';
  const timezoneUnchanged = original !== undefined && values.timezone === original.timezone;
  if (!timezoneUnchanged && !isValidTimezone(values.timezone)) errors.timezone = 'Time zone must be a valid IANA time zone';
  if (!POLICIES.includes(values.missedRunPolicy)) errors.missedRunPolicy = 'Choose a policy';

  let steps: unknown;
  try {
    steps = JSON.parse(values.steps);
  } catch (e) {
    errors.steps = `Steps are not valid JSON: ${(e as Error).message}`;
  }
  if (!errors.steps) {
    if (!Array.isArray(steps) || steps.length === 0) errors.steps = 'Steps must be a non-empty JSON array';
    else {
      const seen = new Set<string>();
      for (let i = 0; i < steps.length && !errors.steps; i++) {
        const problem = stepProblem(steps[i], i, seen);
        if (problem) errors.steps = problem;
      }
    }
  }

  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors,
    payload: {
      name,
      enabled: values.enabled,
      cron: cron || null,
      timezone: values.timezone,
      missedRunPolicy: values.missedRunPolicy,
      steps: steps as StepDefinition[],
    },
  };
}

export function fieldOf(message: string): WorkflowField {
  const match = /^([A-Za-z]+)/.exec(message);
  const field = match?.[1] as WorkflowField | undefined;
  return field && FIELDS.includes(field) ? field : 'form';
}

export function serverErrors(messages: string[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const message of messages) {
    const field = fieldOf(message);
    errors[field] = errors[field] ? `${errors[field]}; ${message}` : message;
  }
  return errors;
}

export function changesFrom(payload: WorkflowPayload, original: WorkflowDto): Partial<WorkflowPayload> {
  const changes: Partial<WorkflowPayload> = {};
  if (payload.name !== original.name) changes.name = payload.name;
  if (payload.enabled !== original.enabled) changes.enabled = payload.enabled;
  if (payload.cron !== original.cron) changes.cron = payload.cron;
  if (payload.timezone !== original.timezone) changes.timezone = payload.timezone;
  if (payload.missedRunPolicy !== original.missedRunPolicy) changes.missedRunPolicy = payload.missedRunPolicy;
  if (JSON.stringify(payload.steps) !== JSON.stringify(original.steps)) changes.steps = payload.steps;
  return changes;
}
