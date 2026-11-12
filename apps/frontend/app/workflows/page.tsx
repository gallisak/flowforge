import Link from 'next/link';
import { Plus } from 'lucide-react';
import { ErrorState } from '@/components/error-state';
import { PageHeader } from '@/components/page-header';
import { RunWorkflowButton } from '@/components/run-workflow-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiFetchPage } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format';
import type { WorkflowSummaryDto } from '@/lib/types';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

export default async function WorkflowsPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const { cursor: requested } = await searchParams;
  const cursor = requested && CURSOR.test(requested) ? requested : undefined;
  let workflows: WorkflowSummaryDto[] = [];
  let nextCursor: string | null = null;
  let failure: ApiError | null = null;
  try {
    ({ items: workflows, nextCursor } = await apiFetchPage<WorkflowSummaryDto>(
      `/workflows?limit=${PAGE_SIZE}${cursor ? `&cursor=${cursor}` : ''}`,
    ));
  } catch (e) {
    failure = e instanceof ApiError ? e : new ApiError(0, ['The API is not reachable']);
  }

  return (
    <>
      <PageHeader
        title="Workflows"
        description="Define the steps, schedule and triggers of your workflows."
        actions={
          <Button asChild>
            <Link href="/workflows/new">
              <Plus />
              New workflow
            </Link>
          </Button>
        }
      />
      {failure && <ErrorState title="Could not load workflows" message={failure.message} status={failure.status} />}
      {!failure && workflows.length === 0 && !cursor && (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <p className="font-medium">No workflows yet</p>
          <p className="text-sm text-muted-foreground">Create your first workflow to start running executions.</p>
          <Button asChild size="sm">
            <Link href="/workflows/new">Create a workflow</Link>
          </Button>
        </Card>
      )}
      {!failure && workflows.length > 0 && (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workflows.map((w) => (
                <TableRow key={w.id}>
                  <TableCell className="font-medium">
                    <Link href={`/workflows/${w.id}/edit`} className="hover:underline">
                      {w.name}
                    </Link>
                  </TableCell>
                  <TableCell>v{w.version}</TableCell>
                  <TableCell className="font-mono text-xs">{w.cron ? `${w.cron} · ${w.timezone}` : '—'}</TableCell>
                  <TableCell className="text-sm">{formatDateTime(w.nextRunAt, w.timezone)}</TableCell>
                  <TableCell>{w.enabled ? <Badge variant="secondary">Enabled</Badge> : <Badge variant="outline">Disabled</Badge>}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-2">
                      <RunWorkflowButton workflowId={w.id} />
                      <Button asChild size="sm" variant="ghost">
                        <Link href={`/executions?workflowId=${w.id}`}>Executions</Link>
                      </Button>
                      <Button asChild size="sm" variant="ghost">
                        <Link href={`/workflows/${w.id}/edit`}>Edit</Link>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {!failure && (cursor || nextCursor) && (
        <div className="mt-4 flex justify-end gap-2">
          {cursor && (
            <Button asChild size="sm" variant="outline">
              <Link href="/workflows">First page</Link>
            </Button>
          )}
          {nextCursor && (
            <Button asChild size="sm" variant="outline">
              <Link href={`/workflows?cursor=${nextCursor}`}>Next page</Link>
            </Button>
          )}
        </div>
      )}
    </>
  );
}
