'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function DisconnectButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function disconnect() {
    setBusy(true);
    await fetch('/api/connect', { method: 'DELETE' });
    router.push('/connect');
    router.refresh();
  }

  return (
    <Button variant="ghost" size="sm" onClick={disconnect} disabled={busy}>
      Disconnect
    </Button>
  );
}
