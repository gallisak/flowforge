'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function DisconnectButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function disconnect() {
    setBusy(true);
    setFailed(false);
    let disconnected = false;
    try {
      disconnected = (await fetch('/api/connect', { method: 'DELETE' })).ok;
    } catch {
      disconnected = false;
    }
    if (!disconnected) {
      setFailed(true);
      setBusy(false);
      return;
    }
    router.push('/connect');
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      {failed && (
        <span role="alert" className="text-sm text-destructive">
          Could not disconnect, try again
        </span>
      )}
      <Button variant="ghost" size="sm" onClick={disconnect} disabled={busy}>
        Disconnect
      </Button>
    </span>
  );
}
