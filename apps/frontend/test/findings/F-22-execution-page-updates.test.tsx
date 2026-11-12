import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionView } from '@/components/execution-view';
import { FakeEventSource } from '../fake-event-source';

const running = { id: 'exec-1', status: 'running', error: null, steps: [] };
const succeeded = {
  ...running,
  status: 'succeeded',
  steps: [{ id: 'run-1', stepIndex: 0, stepId: 'note', status: 'succeeded', attempts: 1, error: null }],
};

describe('F-22 the execution page does not leak work or keep updating forever', () => {
  let current: Record<string, unknown> = running;
  let fetchMock: ReturnType<typeof vi.fn>;

  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

  function publish(snapshot: Record<string, unknown>): void {
    current = snapshot;
    for (const source of FakeEventSource.open()) source.emit('snapshot', snapshot);
  }

  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.reset();
    current = running;
    fetchMock = vi.fn(() => json(current));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stops all network activity and timers once the page is closed', async () => {
    const page = render(<ExecutionView id="exec-1" />);
    await advance(100);
    publish(running);
    await advance(3_000);

    for (const source of FakeEventSource.open()) source.fail(FakeEventSource.CLOSED);
    await advance(0);
    page.unmount();
    const requests = fetchMock.mock.calls.length;
    const connections = FakeEventSource.instances.length;
    await advance(10_000);

    expect(requests).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.length).toBe(requests);
    expect(FakeEventSource.instances).toHaveLength(connections);
    expect(FakeEventSource.open()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops updating once the execution has finished', async () => {
    render(<ExecutionView id="exec-1" />);
    await advance(100);
    publish(running);
    await advance(2_000);
    publish(succeeded);
    await advance(1_000);

    expect(screen.getAllByText(/succeeded/i)).not.toHaveLength(0);
    const requests = fetchMock.mock.calls.length;
    await advance(10_000);

    expect(fetchMock.mock.calls.length).toBe(requests);
    expect(FakeEventSource.open()).toHaveLength(0);
  });

  it('never keeps more than one connection or request to the backend open, also while the connection keeps failing', async () => {
    let inFlight = 0;
    let mostInFlight = 0;
    let mostOpen = 0;
    fetchMock.mockImplementation(async () => {
      inFlight++;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 200));
      inFlight--;
      return json({ statusCode: 502, message: 'The API is not reachable' }, 502);
    });

    render(<ExecutionView id="exec-1" />);
    for (let i = 0; i < 20; i++) {
      await advance(500);
      mostOpen = Math.max(mostOpen, FakeEventSource.open().length);
      for (const source of FakeEventSource.open()) source.fail(FakeEventSource.CLOSED);
    }

    expect(FakeEventSource.instances.length).toBeGreaterThan(1);
    expect(mostOpen).toBe(1);
    expect(mostInFlight).toBe(1);
  });

  it('shows an error instead of loading forever when the execution cannot be loaded', async () => {
    fetchMock.mockImplementation(() => json({ statusCode: 404, message: 'Execution not found' }, 404));

    render(<ExecutionView id="exec-1" />);
    await advance(100);
    for (const source of FakeEventSource.open()) source.fail(FakeEventSource.CLOSED);
    await advance(3_000);

    expect(screen.getByRole('alert')).toHaveTextContent(/not found/i);
  });

  it('shows that it is reconnecting after the connection drops and recovers afterwards', async () => {
    render(<ExecutionView id="exec-1" />);
    await advance(100);
    publish(running);
    await advance(100);

    for (const source of FakeEventSource.open()) source.fail(FakeEventSource.CONNECTING);
    await advance(100);
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();

    publish(succeeded);
    await advance(100);
    expect(screen.queryByText(/reconnecting/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/succeeded/i)).not.toHaveLength(0);
  });
});
