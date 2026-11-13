import { notFound } from 'next/navigation';
import { ErrorState } from '@/components/error-state';
import { WorkflowForm } from '@/components/workflow-form';
import { apiFetch } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import { supportedTimezones } from '@/lib/timezones';
import type { WorkflowDto } from '@/lib/types';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditWorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  try {
    const workflow = await apiFetch<WorkflowDto>(`/workflows/${id}`);
    return <WorkflowForm key={workflow.revision} workflow={workflow} timezones={supportedTimezones()} />;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    const failure = e instanceof ApiError ? e : new ApiError(0, ['The API is not reachable']);
    return <ErrorState title="Could not load the workflow" message={failure.message} status={failure.status} refreshable />;
  }
}
