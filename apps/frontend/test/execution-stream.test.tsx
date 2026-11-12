import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionView } from '@/components/execution-view';
import { RECONNECT_MAX_MS, RECONNECT_MIN_MS } from '@/lib/use-execution-stream';
import { FakeEventSource } from './fake-event-source';

const running = { id: 'exec-1', status: 'running', error: null, steps: [] };
const succeeded = { ...running, status: 'succeeded' };

describe('execution page after the stream is refused', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const respond = (status: number, body: unknown = { statusCode: status }) =>
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
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
    respond(502, { statusCode: 502, message: 'The API is not reachable' });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reconnects once the API is back after it refused a reconnection', async () => {
    render(<ExecutionView id="exec-1" />);
    await advance(0);
    act(() => latest().emit('snapshot', running));

    await refuseLatest();
    expect(screen.getAllByText(/reconnecting/i)).not.toHaveLength(0);
    expect(FakeEventSource.instances).toHaveLength(1);

    await advance(RECONNECT_MIN_MS);
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => latest().emit('snapshot', succeeded));

    expect(screen.queryByText(/reconnecting/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getAllByText(/succeeded/i)).not.toHaveLength(0);
  });

  it('waits longer after every refused attempt up to a ceiling', async () => {
    render(<ExecutionView id="exec-1" />);
    await advance(0);

    const waits: number[] = [];
    let delay = RECONNECT_MIN_MS;
    for (let attempt = 0; attempt < 7; attempt++) {
      const before = FakeEventSource.instances.length;
      await refuseLatest();
      await advance(delay - 1);
      expect(FakeEventSource.instances).toHaveLength(before);
      await advance(1);
      expect(FakeEventSource.instances).toHaveLength(before + 1);
      waits.push(delay);
      delay = Math.min(RECONNECT_MAX_MS, delay * 2);
    }

    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it('starts from the shortest wait again after a successful reconnection', async () => {
    render(<ExecutionView id="exec-1" />);
    await advance(0);
    await refuseLatest();
    await advance(RECONNECT_MIN_MS);
    await refuseLatest();
    await advance(2 * RECONNECT_MIN_MS);
    act(() => latest().emit('snapshot', running));

    const before = FakeEventSource.instances.length;
    await refuseLatest();
    await advance(RECONNECT_MIN_MS);

    expect(FakeEventSource.instances).toHaveLength(before + 1);
  });

  it.each([
    [404, /not found/i],
    [401, /api key/i],
  ])('gives up for good when the execution answers %s', async (status, message) => {
    respond(status);
    render(<ExecutionView id="exec-1" />);
    await advance(0);

    await refuseLatest();
    await advance(10 * RECONNECT_MAX_MS);

    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves nothing behind when the page closes while waiting to reconnect', async () => {
    const page = render(<ExecutionView id="exec-1" />);
    await advance(0);
    await refuseLatest();

    page.unmount();
    const requests = fetchMock.mock.calls.length;
    await advance(10 * RECONNECT_MAX_MS);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.open()).toHaveLength(0);
    expect(fetchMock.mock.calls.length).toBe(requests);
    expect(vi.getTimerCount()).toBe(0);
  });
});
