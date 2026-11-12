type Env = Record<string, string | undefined>;

export function serverConfigProblems(env: Env): string[] {
  const problems: string[] = [];
  if (env.NODE_ENV === 'production' && !env.API_URL) problems.push('API_URL is required in production');
  if (env.APP_ORIGIN) {
    try {
      const origin = new URL(env.APP_ORIGIN);
      if (origin.origin !== env.APP_ORIGIN.replace(/\/$/, '')) problems.push('APP_ORIGIN must be an origin such as https://flowforge.example');
    } catch {
      problems.push('APP_ORIGIN must be an origin such as https://flowforge.example');
    }
  }
  return problems;
}
