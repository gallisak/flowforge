'use client';

import { useEffect, useState } from 'react';

interface Step { id: string; stepIndex: number; stepId: string; status: string; error: string | null }
interface Execution { id: string; status: string; error: string | null; steps: Step[] }

export default function ExecutionPage({ params }: { params: { id: string } }) {
  const [execution, setExecution] = useState<Execution | null>(null);

  useEffect(() => {
    setInterval(async () => {
      const res = await fetch(`/api/proxy/executions/${params.id}`);
      if (res.ok) setExecution(await res.json());
    }, 1000);
  }, [params.id]);

  if (!execution) return <p>Завантаження…</p>;
  return (
    <>
      <h1>Execution {execution.id.slice(0, 8)}</h1>
      <p>Статус: {execution.status}</p>
      {execution.error && <p style={{ color: 'crimson' }}>{execution.error}</p>}
      <ol>
        {execution.steps.map((s) => (
          <li key={s.id}>{s.stepId} — {s.status}</li>
        ))}
      </ol>
    </>
  );
}
