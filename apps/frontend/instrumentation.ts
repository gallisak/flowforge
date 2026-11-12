import { serverConfigProblems } from '@/lib/server-config';

export function register(): void {
  const problems = serverConfigProblems(process.env);
  if (problems.length > 0) throw new Error(`Invalid configuration: ${problems.join('; ')}`);
}
