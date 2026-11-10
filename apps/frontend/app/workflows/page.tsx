import { apiFetch, WorkflowDto } from '@/lib/api';

export default async function WorkflowsPage() {
  let workflows: WorkflowDto[] = [];
  let error: string | null = null;
  try {
    workflows = await apiFetch<WorkflowDto[]>('/workflows');
  } catch (e) {
    error = (e as Error).message;
  }
  return (
    <>
      <h1>Workflows</h1>
      {error && <p style={{ color: 'crimson' }}>Не вдалося завантажити: {error}</p>}
      {!error && workflows.length === 0 && <p>Поки що жодного workflow.</p>}
      <ul>
        {workflows.map((w) => (
          <li key={w.id}>
            {w.name} · v{w.version} {w.cron ? `· cron ${w.cron}` : ''} {w.enabled ? '' : '(вимкнено)'}
          </li>
        ))}
      </ul>
    </>
  );
}
