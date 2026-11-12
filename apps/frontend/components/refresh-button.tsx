'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

export function RefreshButton() {
  const router = useRouter();
  return (
    <Button size="sm" variant="outline" onClick={() => router.refresh()}>
      Try again
    </Button>
  );
}
