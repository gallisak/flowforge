export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '—';
}

export function formatDateTime(value: string | null | undefined, timeZone?: string): string {
  if (!value) return '—';
  if (!timeZone) return new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' });
  return new Date(value).toLocaleString('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'long' });
}

export function formatDuration(from: string | null | undefined, to: string | null | undefined): string {
  if (!from || !to) return '—';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1_000)} s`;
}
