'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorState } from '@/components/error-state';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiRequest } from '@/lib/api-client';
import { ApiError } from '@/lib/api-error';
import { formatDateTime, formatDuration, shortId } from '@/lib/format';
import { EXECUTION_STATUSES, ExecutionDto, WorkflowDto } from '@/lib/types';

export const PAGE_SIZE = 20;
const ANY = 'any';

export interface ExecutionFilters {
  status?: string;
  workflowId?: string;
}

type Phase = 'loading' | 'ready' | 'loading-more' | 'error';

function queryOf(filters: ExecutionFilters, cursor?: string): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (filters.status) params.set('status', filters.status);
  if (filters.workflowId) params.set('workflowId', filters.workflowId);
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

export function ExecutionsList({ filters: given }: { filters: ExecutionFilters }) {
  const filters = useMemo<ExecutionFilters>(() => ({ status: given.status, workflowId: given.workflowId }), [given.status, given.workflowId]);
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState<ExecutionDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowDto[]>([]);
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      setPhase(cursor ? 'loading-more' : 'loading');
      setFailure(null);
      try {
        const { data, headers } = await apiRequest<ExecutionDto[]>(`/executions?${queryOf(filters, cursor)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setItems((current) => (cursor ? [...current, ...data] : data));
        setNextCursor(headers.get('x-next-cursor'));
        setPhase('ready');
      } catch (e) {
        if (controller.signal.aborted) return;
        setFailure(e instanceof ApiError ? e : new ApiError(0, ['The API is not reachable']));
        setPhase('error');
      }
    },
    [filters],
  );

  useEffect(() => {
    void load();
    return () => inFlight.current?.abort();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    apiRequest<WorkflowDto[]>('/workflows', { signal: controller.signal }).then(
      ({ data }) => setWorkflows(data),
      () => undefined,
    );
    return () => controller.abort();
  }, []);

  const names = new Map(workflows.map((w) => [w.id, w.name]));

  function applyFilter(key: keyof ExecutionFilters, value: string) {
    const params = new URLSearchParams();
    const next = { ...filters, [key]: value === ANY ? undefined : value };
    if (next.status) params.set('status', next.status);
    if (next.workflowId) params.set('workflowId', next.workflowId);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Select value={filters.status ?? ANY} onValueChange={(value) => applyFilter('status', value)}>
          <SelectTrigger className="w-44" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any status</SelectItem>
            {EXECUTION_STATUSES.map((status) => (
              <SelectItem key={status} value={status} className="capitalize">
                {status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.workflowId ?? ANY} onValueChange={(value) => applyFilter('workflowId', value)}>
          <SelectTrigger className="w-64" aria-label="Workflow">
            <SelectValue placeholder="Any workflow" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any workflow</SelectItem>
            {filters.workflowId && !names.has(filters.workflowId) && <SelectItem value={filters.workflowId}>{shortId(filters.workflowId)}</SelectItem>}
            {workflows.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {phase === 'error' && failure && (
        <ErrorState title="Could not load executions" message={failure.message} status={failure.status} onRetry={() => void load()} />
      )}

      {phase === 'loading' && (
        <Card className="space-y-3 p-4" aria-busy="true" aria-label="Loading executions">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </Card>
      )}

      {phase !== 'loading' && phase !== 'error' && items.length === 0 && (
        <Card className="p-10 text-center">
          <p className="font-medium">No executions found</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {filters.status || filters.workflowId ? 'Try another filter.' : 'Run a workflow to see its executions here.'}
          </p>
        </Card>
      )}

      {items.length > 0 && phase !== 'loading' && (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Execution</TableHead>
                <TableHead>Workflow</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((execution) => (
                <TableRow key={execution.id}>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/executions/${execution.id}`} className="hover:underline">
                      {shortId(execution.id)}
                    </Link>
                  </TableCell>
                  <TableCell>{names.get(execution.workflowId) ?? shortId(execution.workflowId)}</TableCell>
                  <TableCell>
                    <StatusBadge status={execution.status} />
                  </TableCell>
                  <TableCell className="capitalize">{execution.trigger}</TableCell>
                  <TableCell className="text-sm">{formatDateTime(execution.createdAt)}</TableCell>
                  <TableCell className="text-sm">{formatDuration(execution.createdAt, execution.finishedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {nextCursor && phase !== 'loading' && phase !== 'error' && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void load(nextCursor)} disabled={phase === 'loading-more'}>
            {phase === 'loading-more' ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
