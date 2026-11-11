'use client';

import { useEffect, useState } from 'react';
import type { ExecutionDetailDto } from './types';

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'closed' | 'error';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

async function describeFailure(id: string, signal: AbortSignal): Promise<string> {
  try {
    const res = await fetch(`/api/proxy/executions/${id}`, { signal, cache: 'no-store' });
    if (res.status === 404) return 'Execution not found';
    if (res.status === 401) return 'Your API key is missing or no longer valid';
    if (res.ok) return 'The live connection was refused';
    return `Could not load the execution (HTTP ${res.status})`;
  } catch {
    return 'Could not reach the server';
  }
}

export function useExecutionStream(id: string): { execution: ExecutionDetailDto | null; state: StreamState; error: string | null } {
  const [execution, setExecution] = useState<ExecutionDetailDto | null>(null);
  const [state, setState] = useState<StreamState>('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const failure = new AbortController();
    const source = new EventSource(`/api/executions/${id}/events`);
    setExecution(null);
    setError(null);
    setState('connecting');

    source.addEventListener('snapshot', (event) => {
      const snapshot = JSON.parse((event as MessageEvent<string>).data) as ExecutionDetailDto;
      setExecution(snapshot);
      if (isTerminal(snapshot.status)) {
        source.close();
        setState('closed');
      } else {
        setState('live');
      }
    });
    source.addEventListener('gone', () => {
      source.close();
      setError('Execution not found');
      setState('error');
    });
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        source.close();
        void describeFailure(id, failure.signal).then((message) => {
          if (failure.signal.aborted) return;
          setError(message);
          setState('error');
        });
      } else {
        setState((previous) => (previous === 'closed' || previous === 'error' ? previous : 'reconnecting'));
      }
    };

    return () => {
      failure.abort();
      source.close();
    };
  }, [id]);

  return { execution, state, error };
}
