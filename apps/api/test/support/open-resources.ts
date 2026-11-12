const open = new Set<() => Promise<void>>();

export function trackOpen(close: () => Promise<unknown>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  const closeOnce = () => {
    closing ??= Promise.resolve()
      .then(close)
      .then(() => undefined)
      .finally(() => open.delete(closeOnce));
    return closing;
  };
  open.add(closeOnce);
  return closeOnce;
}

export async function closeOpenResources(): Promise<void> {
  await Promise.allSettled([...open].map((close) => close()));
}
