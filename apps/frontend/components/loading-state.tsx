import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function LoadingState({ label, rows = 5 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <Skeleton className="mb-2 h-8 w-48" />
      <Skeleton className="mb-6 h-4 w-80" />
      <Card className="space-y-3 p-4">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </Card>
      <span className="sr-only">{label}</span>
    </div>
  );
}
