export type ExecutionStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed';

export interface StepRunDto {
  id: string;
  stepIndex: number;
  stepId: string;
  status: string;
  attempts?: number;
  output?: unknown;
  error: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface ExecutionDto {
  id: string;
  workflowId: string;
  workflowVersion: number;
  status: ExecutionStatus;
  trigger: string;
  input: Record<string, unknown>;
  output: unknown;
  error: string | null;
  correlationId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ExecutionDetailDto extends ExecutionDto {
  steps: StepRunDto[];
}

export type MissedRunPolicy = 'skip' | 'once' | 'all';

export type StepDefinition =
  | { id: string; type: 'http'; url: string; method?: string; headers?: Record<string, string>; body?: string }
  | { id: string; type: 'transform'; expr: string }
  | { id: string; type: 'log'; message: string }
  | { id: string; type: 'delay'; ms: number };

export interface WorkflowDto {
  id: string;
  name: string;
  steps: StepDefinition[];
  enabled: boolean;
  cron: string | null;
  timezone: string;
  missedRunPolicy: MissedRunPolicy;
  nextRunAt: string | null;
  version: number;
  createdAt: string;
}

export const EXECUTION_STATUSES: ExecutionStatus[] = ['pending', 'running', 'waiting', 'succeeded', 'failed'];
