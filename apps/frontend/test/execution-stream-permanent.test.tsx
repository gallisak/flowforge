import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionView } from '@/components/execution-view';
import { RECONNECT_MAX_MS } from '@/lib/use-execution-stream';
import { FakeEventSource } from './fake-event-source';

describe('execution page for a request the API will never accept', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([400, 403])('stops reconnecting after the API answers %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ statusCode: status, message: 'refused' }), { status })));
    render(<ExecutionView id="not-a-uuid" />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    act(() => FakeEventSource.instances[0].fail(FakeEventSource.CLOSED));
    await act(() => vi.advanceTimersByTimeAsync(10 * RECONNECT_MAX_MS));

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });
});
