export type ExecutionStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed';

export interface StepRunDto {
  id: string;
  stepIndex: number;
  stepId: string;
  status: string;
  attempts?: number;
  output?: unknown;
  outputTruncated?: boolean;
  error: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface ExecutionSummaryDto {
  id: string;
  workflowId: string;
  workflowVersion: number;
  status: ExecutionStatus;
  trigger: string;
  error: string | null;
  correlationId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ExecutionDto extends ExecutionSummaryDto {
  input: Record<string, unknown>;
  output: unknown;
}

export interface ExecutionDetailDto extends ExecutionDto {
  outputTruncated?: boolean;
  steps: StepRunDto[];
}

export type MissedRunPolicy = 'skip' | 'once' | 'all';

export type StepDefinition =
  | { id: string; type: 'http'; url: string; method?: string; headers?: Record<string, string>; body?: string }
  | { id: string; type: 'transform'; expr: string }
  | { id: string; type: 'log'; message: string }
  | { id: string; type: 'delay'; ms: number };

export interface WorkflowSummaryDto {
  id: string;
  name: string;
  enabled: boolean;
  cron: string | null;
  timezone: string;
  missedRunPolicy: MissedRunPolicy;
  nextRunAt: string | null;
  version: number;
  revision: number;
  createdAt: string;
}

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
  revision: number;
  createdAt: string;
}

export const EXECUTION_STATUSES: ExecutionStatus[] = ['pending', 'running', 'waiting', 'succeeded', 'failed'];
