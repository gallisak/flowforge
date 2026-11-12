'use client';

import { ErrorState } from '@/components/error-state';

export default function PageError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorState title="This page could not be shown" message="Something went wrong while loading it." onRetry={reset} />;
}
