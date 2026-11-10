'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ConnectPage() {
  const router = useRouter();
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/connect', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey }),
    });
    if (!res.ok) return setError('Не вдалося зберегти ключ');
    router.push('/workflows');
  }

  return (
    <form onSubmit={submit}>
      <h1>API-ключ</h1>
      <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="ff_..." style={{ width: 360 }} />
      <button type="submit">Зберегти</button>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
    </form>
  );
}
