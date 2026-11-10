import { cookies } from 'next/headers';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';

export async function apiFetch<T>(path: string): Promise<T> {
  const key = cookies().get('ff_api_key')?.value ?? '';
  const res = await fetch(`${API_URL}${path}`, { headers: { 'x-api-key': key }, cache: 'no-store' });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json() as Promise<T>;
}

export interface WorkflowDto { id: string; name: string; cron: string | null; enabled: boolean; version: number }
export interface StepRunDto { id: string; stepIndex: number; stepId: string; status: string; error: string | null }
export interface ExecutionDto {
  id: string; status: 'pending' | 'running' | 'succeeded' | 'failed'; trigger: string;
  output: unknown; error: string | null; steps: StepRunDto[];
}
