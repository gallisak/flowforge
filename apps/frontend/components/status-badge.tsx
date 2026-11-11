import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const STYLES: Record<string, string> = {
  succeeded: 'border-transparent bg-emerald-100 text-emerald-800',
  failed: 'border-transparent bg-red-100 text-red-800',
  running: 'border-transparent bg-blue-100 text-blue-800',
  waiting: 'border-transparent bg-amber-100 text-amber-800',
  pending: 'border-transparent bg-neutral-100 text-neutral-700',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn('capitalize', STYLES[status] ?? STYLES.pending)}>
      {status}
    </Badge>
  );
}
