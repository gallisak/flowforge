'use client';

import Link from 'next/link';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime, formatDuration, shortId } from '@/lib/format';
import { StreamState, useExecutionStream } from '@/lib/use-execution-stream';
import { cn } from '@/lib/utils';

const CONNECTION: Record<StreamState, { label: string; tone: string }> = {
  connecting: { label: 'Connecting…', tone: 'bg-neutral-400' },
  live: { label: 'Live', tone: 'bg-emerald-500' },
  reconnecting: { label: 'Reconnecting…', tone: 'bg-amber-500 animate-pulse' },
  closed: { label: 'Finished', tone: 'bg-neutral-400' },
  error: { label: 'Disconnected', tone: 'bg-red-500' },
};

function Json({ value }: { value: unknown }) {
  return <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(value, null, 2)}</pre>;
}

function FullOutputLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-sm text-muted-foreground underline hover:text-foreground">
      Too large to show here, open the full output
    </a>
  );
}

function Expandable({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return <span className="text-muted-foreground">—</span>;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]:rotate-90" />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <Json value={value} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ExecutionView({ id }: { id: string }) {
  const { execution, state, error, unauthenticated } = useExecutionStream(id);
  const connection = CONNECTION[state];

  return (
    <div className="space-y-6">
      <Link href="/executions" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Executions
      </Link>

      {error && (
        <Alert variant={state === 'reconnecting' ? 'default' : 'destructive'}>
          <AlertTitle>{state === 'reconnecting' ? 'Connection lost, reconnecting…' : 'Could not follow this execution'}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{error}</span>
            {unauthenticated && (
              <Button asChild size="sm" variant="outline">
                <Link href="/connect">Connect</Link>
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {!execution && !error && (
        <div className="space-y-3" aria-busy="true" aria-label="Loading execution">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      {execution && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">Execution {shortId(execution.id)}</h1>
            <div role="status" aria-live="polite" aria-atomic="true" className="flex flex-1 flex-wrap items-center gap-3">
              <StatusBadge status={execution.status} />
              <span className="ml-auto inline-flex items-center gap-2 text-sm text-muted-foreground">
                <span className={cn('h-2 w-2 rounded-full', connection.tone)} aria-hidden="true" />
                {connection.label}
              </span>
            </div>
          </div>

          {execution.error && (
            <Alert variant="destructive">
              <AlertTitle>Execution failed</AlertTitle>
              <AlertDescription>{execution.error}</AlertDescription>
            </Alert>
          )}

          <Card>
            <CardContent className="grid gap-4 pt-6 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <p className="text-muted-foreground">Workflow</p>
                <Link href={`/executions?workflowId=${execution.workflowId}`} className="font-mono hover:underline">
                  {shortId(execution.workflowId)}
                </Link>{' '}
                <Badge variant="outline">v{execution.workflowVersion}</Badge>
              </div>
              <div>
                <p className="text-muted-foreground">Trigger</p>
                <p className="capitalize">{execution.trigger}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Correlation id</p>
                <p className="break-all font-mono text-xs">{execution.correlationId ?? '—'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Created</p>
                <p>{formatDateTime(execution.createdAt)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Finished</p>
                <p>{formatDateTime(execution.finishedAt)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Duration</p>
                <p>{formatDuration(execution.createdAt, execution.finishedAt)}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Steps</CardTitle>
            </CardHeader>
            <CardContent>
              {execution.steps.length === 0 ? (
                <p className="text-sm text-muted-foreground">No step has started yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      <TableHead>Step</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Attempts</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Result</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {execution.steps.map((step) => (
                      <TableRow key={step.id} className="align-top">
                        <TableCell>{step.stepIndex + 1}</TableCell>
                        <TableCell className="font-mono text-xs">{step.stepId}</TableCell>
                        <TableCell>
                          <StatusBadge status={step.status} />
                        </TableCell>
                        <TableCell>{step.attempts ?? '—'}</TableCell>
                        <TableCell>{formatDuration(step.startedAt, step.finishedAt)}</TableCell>
                        <TableCell className="max-w-md">
                          {step.error ? (
                            <p className="text-sm text-destructive">{step.error}</p>
                          ) : step.outputTruncated ? (
                            <FullOutputLink href={`/api/proxy/executions/${id}/steps/${step.stepIndex}/output`} />
                          ) : (
                            <Expandable label="Output" value={step.output} />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Input</CardTitle>
              </CardHeader>
              <CardContent>
                <Json value={execution.input} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Output</CardTitle>
              </CardHeader>
              <CardContent>
                {execution.outputTruncated ? (
                  <FullOutputLink href={`/api/proxy/executions/${id}/output`} />
                ) : execution.output === null || execution.output === undefined ? (
                  <p className="text-sm text-muted-foreground">—</p>
                ) : (
                  <Json value={execution.output} />
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
