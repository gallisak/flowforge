import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { RefreshButton } from '@/components/refresh-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

const NOT_CONNECTED = 'Connect with a valid API key first';

export function ErrorState({
  title,
  message,
  status,
  onRetry,
  refreshable,
}: {
  title: string;
  message: string;
  status?: number;
  onRetry?: () => void;
  refreshable?: boolean;
}) {
  const unauthenticated = status === 401;
  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{unauthenticated ? NOT_CONNECTED : message}</span>
        {unauthenticated && (
          <Button asChild size="sm" variant="outline">
            <Link href="/connect">Connect</Link>
          </Button>
        )}
        {!unauthenticated && onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        )}
        {!unauthenticated && !onRetry && refreshable && <RefreshButton />}
      </AlertDescription>
    </Alert>
  );
}
