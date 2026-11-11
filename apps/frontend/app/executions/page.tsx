import { ExecutionsList } from '@/components/executions-list';
import { PageHeader } from '@/components/page-header';
import { EXECUTION_STATUSES, ExecutionStatus } from '@/lib/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ExecutionsPage({ searchParams }: { searchParams: { status?: string; workflowId?: string } }) {
  const status = EXECUTION_STATUSES.includes(searchParams.status as ExecutionStatus) ? searchParams.status : undefined;
  const workflowId = searchParams.workflowId && UUID.test(searchParams.workflowId) ? searchParams.workflowId : undefined;
  return (
    <>
      <PageHeader title="Executions" description="Newest first. Open an execution to follow it live." />
      <ExecutionsList key={`${status ?? ''}|${workflowId ?? ''}`} filters={{ status, workflowId }} />
    </>
  );
}
