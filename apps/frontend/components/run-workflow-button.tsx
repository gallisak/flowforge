'use client';

import { Play } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api-client';
import { failureMessage } from '@/lib/api-error';
import type { ExecutionDto } from '@/lib/types';

export function RunWorkflowButton({ workflowId }: { workflowId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const { data } = await apiRequest<ExecutionDto>(`/workflows/${workflowId}/run`, { method: 'POST', body: {} });
      router.push(`/executions/${data.id}`);
    } catch (e) {
      setError(failureMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={run} disabled={busy}>
        <Play />
        {busy ? 'Starting…' : 'Run'}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
