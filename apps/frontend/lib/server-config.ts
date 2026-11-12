type Env = Record<string, string | undefined>;

export function serverConfigProblems(env: Env): string[] {
  const problems: string[] = [];
  if (env.NODE_ENV === 'production' && !env.API_URL) problems.push('API_URL is required in production');
  const secret = env.CLIENT_ADDRESS_SECRET ?? '';
  if (secret.length > 0 && secret.length < 32) problems.push('CLIENT_ADDRESS_SECRET must be at least 32 characters');
  const hops = env.TRUSTED_PROXY_HOPS ?? '';
  if (hops !== '' && !/^(10|[0-9])$/.test(hops)) problems.push('TRUSTED_PROXY_HOPS must be an integer between 0 and 10');
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
