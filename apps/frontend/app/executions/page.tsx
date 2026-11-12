import { ExecutionsList } from '@/components/executions-list';
import { PageHeader } from '@/components/page-header';
import { EXECUTION_STATUSES, ExecutionStatus } from '@/lib/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ExecutionsPage({ searchParams }: { searchParams: Promise<{ status?: string; workflowId?: string }> }) {
  const query = await searchParams;
  const status = EXECUTION_STATUSES.includes(query.status as ExecutionStatus) ? query.status : undefined;
  const workflowId = query.workflowId && UUID.test(query.workflowId) ? query.workflowId : undefined;
  return (
    <>
      <PageHeader title="Executions" description="Newest first. Open an execution to follow it live." />
      <ExecutionsList key={`${status ?? ''}|${workflowId ?? ''}`} filters={{ status, workflowId }} />
    </>
  );
}
