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
