import { describe, expect, it } from 'vitest';
import type { WorkflowDto } from '@/lib/types';
import { changesFrom, emptyValues, fieldOf, serverErrors, validateWorkflow, valuesFrom, WorkflowFormValues } from '@/lib/workflow-form';

const valid = (overrides: Partial<WorkflowFormValues> = {}): WorkflowFormValues => ({ ...emptyValues(), name: 'Orders', ...overrides });
const stepsError = (steps: unknown) => validateWorkflow(valid({ steps: typeof steps === 'string' ? steps : JSON.stringify(steps) })).errors.steps;

describe('validateWorkflow', () => {
  it('builds the payload of a valid form', () => {
    const { errors, payload } = validateWorkflow(valid({ name: '  Orders  ', cron: ' 0 9 * * 1-5 ', timezone: 'Europe/Kyiv' }));

    expect(errors).toEqual({});
    expect(payload).toMatchObject({ name: 'Orders', cron: '0 9 * * 1-5', timezone: 'Europe/Kyiv', missedRunPolicy: 'once', enabled: true });
    expect(payload?.steps).toHaveLength(3);
  });

  it('sends no schedule for an empty cron', () => {
    expect(validateWorkflow(valid({ cron: '   ' })).payload?.cron).toBeNull();
  });

  it.each([
    [{ name: '' }, 'name', 'Name is required'],
    [{ name: 'x'.repeat(201) }, 'name', 'Name must be at most 200 characters'],
    [{ cron: '0 9 *' }, 'cron', 'Cron must have 5 fields, or 6 with seconds'],
    [{ timezone: 'Mars/Olympus' }, 'timezone', 'Time zone must be a valid IANA time zone'],
  ] as const)('rejects %j', (overrides, field, message) => {
    expect(validateWorkflow(valid(overrides)).errors[field]).toBe(message);
  });

  it.each([
    ['broken JSON', '[{', /not valid JSON/],
    ['an empty list', [], 'Steps must be a non-empty JSON array'],
    ['a missing id', [{ type: 'log', message: 'x' }], 'Step 1 needs an id'],
    ['an id with capitals', [{ id: 'Fetch', type: 'log', message: 'x' }], /needs an id of lowercase letters/],
    ['a repeated id', [{ id: 'a', type: 'log', message: 'x' }, { id: 'a', type: 'log', message: 'y' }], 'Step 2 repeats the id "a"'],
    ['an unknown type', [{ id: 'a', type: 'email' }], /must have a type of/],
    ['an http step without url', [{ id: 'a', type: 'http' }], 'Step 1 needs a url'],
    ['headers that are not text', [{ id: 'a', type: 'http', url: 'https://x.test', headers: { n: 1 } }], 'Step 1 must have headers with text values'],
    ['a negative delay', [{ id: 'a', type: 'delay', ms: -1 }], 'Step 1 needs a number of milliseconds from 0 to 3600000'],
    ['a delay above one hour', [{ id: 'a', type: 'delay', ms: 3_600_001 }], 'Step 1 needs a number of milliseconds from 0 to 3600000'],
    ['a transform without expression', [{ id: 'a', type: 'transform' }], 'Step 1 needs an expression'],
    ['a misspelled field', [{ id: 'a', type: 'http', url: 'https://x.test', header: {} }], 'Step 1 has a field "header" that http steps do not have'],
  ])('rejects steps with %s', (_case, steps, message) => {
    const error = stepsError(steps);
    if (typeof message === 'string') expect(error).toBe(message);
    else expect(error).toMatch(message);
  });

  it.each([
    ['a delay of zero', [{ id: 'a', type: 'delay', ms: 0 }]],
    ['a fractional delay', [{ id: 'a', type: 'delay', ms: 1.5 }]],
    ['an empty transform expression', [{ id: 'a', type: 'transform', expr: '' }]],
  ])('accepts steps the API accepts: %s', (_case, steps) => {
    expect(stepsError(steps)).toBeUndefined();
  });
});

describe('server errors', () => {
  it('assigns each API message to the field it names', () => {
    expect(
      serverErrors([
        'steps[0].url must be an absolute http(s) URL',
        'cron must not fire more often than once per minute',
        'name must be a string',
        'Workflow not found',
      ]),
    ).toEqual({
      steps: 'steps[0].url must be an absolute http(s) URL',
      cron: 'cron must not fire more often than once per minute',
      name: 'name must be a string',
      form: 'Workflow not found',
    });
  });

  it('treats unknown words as form errors', () => {
    expect(fieldOf('property foo should not exist')).toBe('form');
  });
});

describe('validateWorkflow with values the API accepted before', () => {
  const stored: WorkflowDto = {
    id: 'w1',
    name: '   ',
    steps: [{ id: 'a', type: 'log', message: 'x' }],
    enabled: true,
    cron: '0 9 * * *',
    timezone: 'Asia/Kolkata',
    missedRunPolicy: 'once',
    nextRunAt: null,
    version: 1,
    revision: 1,
    createdAt: '2026-11-20T09:00:00Z',
  };

  it.each(['Asia/Kolkata', 'Europe/Kyiv', 'Etc/UTC', 'US/Eastern', 'europe/kyiv'])('accepts the time zone %s that the API accepts', (timezone) => {
    expect(validateWorkflow(valid({ timezone })).errors).toEqual({});
  });

  it('lets a workflow with a stored name and time zone be disabled', () => {
    const { errors, payload } = validateWorkflow({ ...valuesFrom(stored), enabled: false }, stored);

    expect(errors).toEqual({});
    expect(changesFrom(payload!, stored)).toEqual({ enabled: false });
  });
});

describe('changesFrom', () => {
  const original: WorkflowDto = {
    id: 'w1',
    name: 'Orders',
    steps: [{ id: 'a', type: 'log', message: 'x' }],
    enabled: true,
    cron: null,
    timezone: 'UTC',
    missedRunPolicy: 'once',
    nextRunAt: null,
    version: 3,
    revision: 3,
    createdAt: '2026-11-20T09:00:00Z',
  };

  it('leaves out unchanged steps so that saving does not create a new version', () => {
    const changes = changesFrom({ ...original, name: 'Orders v2' }, original);

    expect(changes).toEqual({ name: 'Orders v2' });
  });

  it('includes steps that changed', () => {
    const steps = [{ id: 'a', type: 'log' as const, message: 'y' }];

    expect(changesFrom({ ...original, steps }, original)).toEqual({ steps });
  });
});
