'use client';

import { useEffect, useState } from 'react';
import type { ExecutionDetailDto } from './types';

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'closed' | 'error';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

interface StreamFailure {
  permanent: boolean;
  message: string;
  unauthenticated?: boolean;
  execution?: ExecutionDetailDto;
}

function looksLikeExecution(value: unknown): value is ExecutionDetailDto {
  const candidate = value as Partial<ExecutionDetailDto> | null;
  return typeof candidate === 'object' && candidate !== null && typeof candidate.status === 'string' && Array.isArray(candidate.steps);
}

async function describeFailure(id: string, signal: AbortSignal): Promise<StreamFailure> {
  try {
    const res = await fetch(`/api/proxy/executions/${id}`, { signal, cache: 'no-store' });
    if (res.status === 404) return { permanent: true, message: 'Execution not found' };
    if (res.status === 401) return { permanent: true, unauthenticated: true, message: 'Your API key is missing or no longer valid' };
    if (res.status === 400) return { permanent: true, message: 'This is not a valid execution id' };
    if (res.status === 403) return { permanent: true, message: 'This request is not allowed' };
    if (res.ok) {
      const execution: unknown = await res.json().catch(() => null);
      if (!looksLikeExecution(execution)) return { permanent: false, message: 'The server sent an unexpected response' };
      return { permanent: false, message: 'The live connection was refused', execution };
    }
    return { permanent: false, message: `Could not load the execution (HTTP ${res.status})` };
  } catch {
    return { permanent: false, message: 'Could not reach the server' };
  }
}

export interface ExecutionStream {
  execution: ExecutionDetailDto | null;
  state: StreamState;
  error: string | null;
  unauthenticated: boolean;
}

export function useExecutionStream(id: string): ExecutionStream {
  const [execution, setExecution] = useState<ExecutionDetailDto | null>(null);
  const [state, setState] = useState<StreamState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [unauthenticated, setUnauthenticated] = useState(false);

  useEffect(() => {
    const stopped = new AbortController();
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectDelayMs = RECONNECT_MIN_MS;

    const scheduleReconnect = () => {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, reconnectDelayMs);
      reconnectDelayMs = Math.min(RECONNECT_MAX_MS, reconnectDelayMs * 2);
    };

    const connect = () => {
      const current = new EventSource(`/api/executions/${id}/events`);
      source = current;

      current.addEventListener('snapshot', (event) => {
        const snapshot = JSON.parse((event as MessageEvent<string>).data) as ExecutionDetailDto;
        reconnectDelayMs = RECONNECT_MIN_MS;
        setExecution(snapshot);
        setError(null);
        if (isTerminal(snapshot.status)) {
          current.close();
          setState('closed');
        } else {
          setState('live');
        }
      });
      current.addEventListener('gone', () => {
        current.close();
        setError('Execution not found');
        setState('error');
      });
      current.onerror = () => {
        if (current.readyState !== EventSource.CLOSED) {
          setState((previous) => (previous === 'closed' || previous === 'error' ? previous : 'reconnecting'));
          return;
        }
        current.close();
        void describeFailure(id, stopped.signal).then((failure) => {
          if (stopped.signal.aborted) return;
          if (failure.execution) {
            setExecution(failure.execution);
            if (isTerminal(failure.execution.status)) {
              setError(null);
              setState('closed');
              return;
            }
          }
          setError(failure.message);
          setUnauthenticated(Boolean(failure.unauthenticated));
          if (failure.permanent) {
            setState('error');
            return;
          }
          setState('reconnecting');
          scheduleReconnect();
        });
      };
    };

    setExecution(null);
    setError(null);
    setUnauthenticated(false);
    setState('connecting');
    connect();

    return () => {
      stopped.abort();
      clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [id]);

  return { execution, state, error, unauthenticated };
}
