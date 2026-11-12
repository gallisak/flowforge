import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionView } from '@/components/execution-view';
import { FakeEventSource } from './fake-event-source';

const ID = '48c61687-afc1-474c-85ae-678f21b706d2';

describe('execution page with outputs too large for a snapshot', () => {
  beforeEach(() => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('links to the full outputs instead of showing them', async () => {
    render(<ExecutionView id={ID} />);
    act(() =>
      FakeEventSource.instances[0].emit('snapshot', {
        id: ID,
        workflowId: ID,
        workflowVersion: 1,
        status: 'succeeded',
        trigger: 'api',
        error: null,
        input: {},
        output: null,
        outputTruncated: true,
        createdAt: '2026-11-12T10:00:00.000Z',
        finishedAt: '2026-11-12T10:00:01.000Z',
        steps: [{ id: 'run-1', stepIndex: 0, stepId: 'big', status: 'succeeded', attempts: 1, error: null, output: null, outputTruncated: true }],
      }),
    );

    const links = screen.getAllByRole('link', { name: /full output/i }).map((link) => link.getAttribute('href'));
    expect(links).toEqual([`/api/proxy/executions/${ID}/steps/0/output`, `/api/proxy/executions/${ID}/output`]);
  });
});
