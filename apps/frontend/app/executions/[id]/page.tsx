'use client';

import { StreamState, useExecutionStream } from '@/lib/use-execution-stream';

const CONNECTION_LABELS: Record<StreamState, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  closed: 'Finished',
  error: 'Disconnected',
};

export default function ExecutionPage({ params }: { params: { id: string } }) {
  const { execution, state, error } = useExecutionStream(params.id);

  if (error) return <p role="alert">{error}</p>;
  if (!execution) return <p>Loading…</p>;
  return (
    <>
      <h1>Execution {execution.id.slice(0, 8)}</h1>
      <p>Status: {execution.status}</p>
      <p>{CONNECTION_LABELS[state]}</p>
      {execution.error && <p role="alert">{execution.error}</p>}
      <ol>
        {execution.steps.map((s) => (
          <li key={s.id}>
            {s.stepId} — {s.status}
          </li>
        ))}
      </ol>
    </>
  );
}
