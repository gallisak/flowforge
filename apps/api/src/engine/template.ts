export interface StepContext {
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
}

function lookup(ctx: StepContext, path: string): unknown {
  let cur: unknown = ctx;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function renderTemplate(template: string, ctx: StepContext): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, path: string) => {
    const value = lookup(ctx, path);
    if (value === undefined || value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}
