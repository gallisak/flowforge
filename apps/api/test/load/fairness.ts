import { execSync } from 'child_process';
import { fromEnvOrRootEnvFile } from '../support/root-env';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const STOP_WORKERS = process.env.STOP_WORKERS ?? 'docker compose -p flowforge stop worker';
const START_WORKERS = process.env.START_WORKERS ?? 'docker compose -p flowforge start worker';
const ADMIN_TOKEN = fromEnvOrRootEnvFile('ADMIN_TOKEN');
if (!ADMIN_TOKEN) {
  process.stderr.write('Set ADMIN_TOKEN in the .env file at the repository root, or in the environment\n');
  process.exit(2);
}
const BACKLOG = Number(process.env.BACKLOG ?? 20_000);
const DURATION_SECONDS = Number(process.env.DURATION_SECONDS ?? 60);
const ENQUEUE_CONCURRENCY = 64;

interface Tenant {
  name: string;
  apiKey: string;
  workflowId: string;
}

interface ExecutionView {
  id: string;
  status: string;
  createdAt: string;
  steps: Array<{ startedAt: string }>;
}

async function call<T>(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

async function createTenant(name: string): Promise<Tenant> {
  const tenant = await call<{ id: string; apiKey: string }>('POST', '/tenants', { 'x-admin-token': ADMIN_TOKEN }, { name });
  if (tenant.status !== 201) throw new Error(`could not create tenant ${name}: ${tenant.status}`);
  await call('PATCH', `/tenants/${tenant.body.id}/limits`, { 'x-admin-token': ADMIN_TOKEN }, { maxQueuedJobs: 1_000_000, rateLimitPerMinute: 1_000_000 });
  const workflow = await call<{ id: string }>(
    'POST',
    '/workflows',
    { 'x-api-key': tenant.body.apiKey },
    { name: `${name}-load`, steps: [{ id: 'note', type: 'log', message: 'load {{ input.n }}' }] },
  );
  if (workflow.status !== 201) throw new Error(`could not create workflow for ${name}: ${workflow.status}`);
  return { name, apiKey: tenant.body.apiKey, workflowId: workflow.body.id };
}

async function run(tenant: Tenant, n: number): Promise<string> {
  const res = await call<{ id: string }>('POST', `/workflows/${tenant.workflowId}/run`, { 'x-api-key': tenant.apiKey }, { n });
  if (res.status !== 201) throw new Error(`run for ${tenant.name} failed: ${res.status}`);
  return res.body.id;
}

async function execution(tenant: Tenant, id: string): Promise<ExecutionView> {
  return (await call<ExecutionView>('GET', `/executions/${id}`, { 'x-api-key': tenant.apiKey })).body;
}

async function waitUntilSucceeded(tenant: Tenant, id: string, timeoutMs: number): Promise<ExecutionView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await execution(tenant, id);
    if (current.status === 'succeeded' || current.status === 'failed') return current;
    if (Date.now() > deadline) throw new Error(`execution ${id} of ${tenant.name} did not finish in time`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarize(name: string, latencies: number[]): string {
  const sorted = [...latencies].sort((a, b) => a - b);
  const cells = [50, 95, 99].map((p) => `${percentile(sorted, p)}`).concat(`${sorted[sorted.length - 1]}`);
  return `| ${name} | ${sorted.length} | ${cells.join(' | ')} |`;
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const [noisy, quietB, quietC] = await Promise.all(['noisy-a', 'quiet-b', 'quiet-c'].map((n) => createTenant(`${n}-${stamp}`)));

  execSync(STOP_WORKERS, { stdio: 'ignore' });
  const enqueueStarted = Date.now();
  let next = 0;
  let lastNoisy = '';
  await Promise.all(
    Array.from({ length: ENQUEUE_CONCURRENCY }, async () => {
      while (next < BACKLOG) {
        const n = next++;
        const id = await run(noisy, n);
        if (n === BACKLOG - 1) lastNoisy = id;
      }
    }),
  );
  const enqueueSeconds = (Date.now() - enqueueStarted) / 1000;
  execSync(START_WORKERS, { stdio: 'ignore' });
  const workersStarted = Date.now();

  const quietRuns: Record<string, string[]> = { [quietB.name]: [], [quietC.name]: [] };
  for (let second = 0; second < DURATION_SECONDS; second++) {
    const tick = Date.now();
    for (const tenant of [quietB, quietC]) quietRuns[tenant.name].push(await run(tenant, second));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1_000 - (Date.now() - tick))));
  }

  const lastDone = await waitUntilSucceeded(noisy, lastNoisy, 30 * 60_000);
  const drainedAt = new Date(lastDone.steps[0].startedAt).getTime();
  const drainSeconds = (drainedAt - workersStarted) / 1000;

  const rows: string[] = [];
  for (const tenant of [quietB, quietC]) {
    const during: number[] = [];
    const after: number[] = [];
    for (const id of quietRuns[tenant.name]) {
      const done = await waitUntilSucceeded(tenant, id, 30 * 60_000);
      const createdAt = new Date(done.createdAt).getTime();
      const latency = new Date(done.steps[0].startedAt).getTime() - createdAt;
      (createdAt < drainedAt ? during : after).push(latency);
    }
    const label = tenant === quietB ? 'B' : 'C';
    if (during.length > 0) rows.push(summarize(`${label}, while the backlog of A drains`, during));
    if (after.length > 0) rows.push(summarize(`${label}, after the backlog of A drained`, after));
  }

  process.stdout.write(
    [
      `backlog of tenant A: ${BACKLOG} jobs enqueued through the API in ${enqueueSeconds.toFixed(1)} s while the workers were stopped`,
      `tenants B and C: 1 execution per second each for ${DURATION_SECONDS} s, starting when the workers started`,
      `tenant A backlog drained ${drainSeconds.toFixed(1)} s after the workers started (${(BACKLOG / drainSeconds).toFixed(0)} jobs/s)`,
      '',
      '| tenant | executions | p50 ms | p95 ms | p99 ms | max ms |',
      '|---|---|---|---|---|---|',
      ...rows,
      '',
    ].join('\n'),
  );
}

main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
