import { serverConfigProblems } from '@/lib/server-config';

const PRODUCTION_BUILD_PHASE = 'phase-production-build';

export function register(): void {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === PRODUCTION_BUILD_PHASE) return;
  const problems = serverConfigProblems(process.env);
  if (problems.length === 0) return;
  for (const problem of problems) console.error(`Invalid configuration: ${problem}`);
  process.exit(1);
}
