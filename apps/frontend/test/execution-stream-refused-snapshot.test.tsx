import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionView } from '@/components/execution-view';
import { RECONNECT_MAX_MS, RECONNECT_MIN_MS } from '@/lib/use-execution-stream';
import { FakeEventSource } from './fake-event-source';

const running = { id: 'exec-1', workflowId: 'wf-1', workflowVersion: 1, status: 'running', trigger: 'api', error: null, input: {}, output: null, steps: [] };
const succeeded = { ...running, status: 'succeeded', finishedAt: '2026-11-12T10:00:01.000Z', createdAt: '2026-11-12T10:00:00.000Z' };

describe('execution page when the live stream is refused but the execution can be read', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const respond = (status: number, body: unknown) =>
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

  async function refuseLatest(): Promise<void> {
    act(() => latest().fail(FakeEventSource.CLOSED));
    await advance(0);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.reset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the execution it read and keeps trying to go live while it is still running', async () => {
    respond(200, running);
    render(<ExecutionView id="exec-1" />);
    await advance(0);

    await refuseLatest();

    expect(screen.getByRole('heading', { name: /Execution exec-1/ })).toBeInTheDocument();
    expect(screen.getAllByText(/running/i)).not.toHaveLength(0);
    await advance(RECONNECT_MIN_MS);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('shows a finished execution it read and stops reconnecting', async () => {
    respond(200, succeeded);
    render(<ExecutionView id="exec-1" />);
    await advance(0);

    await refuseLatest();
    await advance(10 * RECONNECT_MAX_MS);

    expect(screen.getByRole('heading', { name: /Execution exec-1/ })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Finished');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('offers to connect again when the API key is no longer valid', async () => {
    respond(401, { statusCode: 401, message: 'Invalid API key' });
    render(<ExecutionView id="exec-1" />);
    await advance(0);

    await refuseLatest();

    expect(within(screen.getByRole('alert')).getByRole('link', { name: 'Connect' })).toHaveAttribute('href', '/connect');
  });

  it('announces changes of the connection and of the status politely', async () => {
    render(<ExecutionView id="exec-1" />);
    await advance(0);
    act(() => latest().emit('snapshot', running));

    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent(/running/i);
    expect(region).toHaveTextContent('Live');

    act(() => latest().emit('snapshot', succeeded));

    expect(screen.getByRole('status')).toHaveTextContent(/succeeded/i);
    expect(screen.getByRole('status')).toHaveTextContent('Finished');
  });
});
